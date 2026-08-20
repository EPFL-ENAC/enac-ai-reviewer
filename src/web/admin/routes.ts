import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  cancelJob,
  countJobs,
  countJobsByStatus,
  getJobById,
  getJobTraces,
  insertJobTrace,
  listJobs,
  retryJob,
} from '../../db/jobs.js';
import type { Sql } from '../../db/pool.js';
import type { WebConfig } from '../../domain/config.js';
import { getAdminUser, isAdminUserAllowed, type AdminUser } from './auth.js';
import { renderJobDetail, renderJobsList } from './templates.js';

const BASE_PATH = '/admin/jobs';

function requireAdminUserHtml(request: FastifyRequest, reply: FastifyReply, config: WebConfig): AdminUser | null {
  const user = getAdminUser(request, config);
  if (!user || !isAdminUserAllowed(user, config)) {
    reply.code(401).type('text/html').send(`<!doctype html>
<html>
<head><title>Admin — Authentication required</title></head>
<body>
  <h1>Authentication required</h1>
  <p>Please access <code>/admin</code> through the organisation authentication proxy.</p>
</body>
</html>`);
    return null;
  }
  return user;
}

function requireAdminUserJson(request: FastifyRequest, reply: FastifyReply, config: WebConfig): AdminUser | null {
  const user = getAdminUser(request, config);
  if (!user || !isAdminUserAllowed(user, config)) {
    reply.code(401).send({ error: 'Authentication required' });
    return null;
  }
  return user;
}

function parseListQuery(query: Record<string, unknown>): {
  status?: string;
  page: number;
  pageSize: number;
} {
  const status = typeof query.status === 'string' ? query.status : undefined;
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(String(query.pageSize ?? '50'), 10) || 50));
  return { status, page, pageSize };
}

export function registerAdminUi(app: FastifyInstance, sql: Sql, config: WebConfig): void {
  app.get('/admin', async (request, reply) => {
    const user = requireAdminUserHtml(request, reply, config);
    if (!user) return;
    return reply.redirect(BASE_PATH);
  });

  app.get(BASE_PATH, async (request, reply) => {
    const user = requireAdminUserHtml(request, reply, config);
    if (!user) return;

    const { status, page, pageSize } = parseListQuery(request.query as Record<string, unknown>);
    const offset = (page - 1) * pageSize;

    const [jobs, total, counts] = await Promise.all([
      listJobs(sql, { status, limit: pageSize, offset }),
      countJobs(sql, { status }),
      countJobsByStatus(sql),
    ]);

    reply.type('text/html').send(
      renderJobsList({ jobs, counts, statusFilter: status, page, pageSize, total, basePath: BASE_PATH }),
    );
  });

  app.get(`${BASE_PATH}/:id`, async (request, reply) => {
    const user = requireAdminUserHtml(request, reply, config);
    if (!user) return;

    const { id } = request.params as { id: string };
    const [job, traces] = await Promise.all([getJobById(sql, id), getJobTraces(sql, id)]);

    if (!job) {
      reply.code(404).type('text/html').send(`<!doctype html>
<html><head><title>Not found</title></head><body><h1>Job not found</h1></body></html>`);
      return;
    }

    reply.type('text/html').send(renderJobDetail({ job, traces, basePath: BASE_PATH }));
  });

  app.get('/admin/api/jobs', async (request, reply) => {
    const user = requireAdminUserJson(request, reply, config);
    if (!user) return;

    const { status, page, pageSize } = parseListQuery(request.query as Record<string, unknown>);
    const offset = (page - 1) * pageSize;

    const [jobs, total, counts] = await Promise.all([
      listJobs(sql, { status, limit: pageSize, offset }),
      countJobs(sql, { status }),
      countJobsByStatus(sql),
    ]);

    return { jobs, total, counts, page, pageSize };
  });

  app.get('/admin/api/jobs/:id', async (request, reply) => {
    const user = requireAdminUserJson(request, reply, config);
    if (!user) return;

    const { id } = request.params as { id: string };
    const [job, traces] = await Promise.all([getJobById(sql, id), getJobTraces(sql, id)]);

    if (!job) {
      reply.code(404).send({ error: 'Job not found' });
      return;
    }

    return { job, traces };
  });

  app.post(`${BASE_PATH}/:id/cancel`, async (request, reply) => {
    const user = requireAdminUserHtml(request, reply, config);
    if (!user) return;

    const { id } = request.params as { id: string };
    const job = await getJobById(sql, id);
    if (!job) {
      reply.code(404).type('text/html').send(`<!doctype html>
<html><head><title>Not found</title></head><body><h1>Job not found</h1></body></html>`);
      return;
    }

    await cancelJob(sql, id);
    await insertJobTrace(sql, { jobId: id, type: 'admin_cancel', payload: { actor: user.user } });

    const redirectTo = typeof request.headers.referer === 'string' ? request.headers.referer : BASE_PATH;
    return reply.redirect(redirectTo);
  });

  app.post(`${BASE_PATH}/:id/retry`, async (request, reply) => {
    const user = requireAdminUserHtml(request, reply, config);
    if (!user) return;

    const { id } = request.params as { id: string };
    const job = await getJobById(sql, id);
    if (!job) {
      reply.code(404).type('text/html').send(`<!doctype html>
<html><head><title>Not found</title></head><body><h1>Job not found</h1></body></html>`);
      return;
    }

    const retried = await retryJob(sql, id);
    if (retried) {
      await insertJobTrace(sql, { jobId: id, type: 'admin_retry', payload: { actor: user.user } });
    }

    const redirectTo = typeof request.headers.referer === 'string' ? request.headers.referer : `${BASE_PATH}/${id}`;
    return reply.redirect(redirectTo);
  });
}
