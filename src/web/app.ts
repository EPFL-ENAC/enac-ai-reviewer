import type { App } from '@octokit/app';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Sql } from '../db/pool.js';
import type { WebConfig } from '../domain/config.js';
import { registerGithubWebhook } from './github-webhook.js';
import { registry } from './metrics.js';

export function buildApp(sql: Sql, config: WebConfig, githubApp: App): FastifyInstance {
  const app = Fastify({ logger: true });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, rawBody, done) => {
    const buf = rawBody as Buffer;
    (request as { rawBody?: Buffer }).rawBody = buf;
    try {
      const json: unknown = buf.length ? JSON.parse(buf.toString('utf8')) : {};
      done(null, json);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  registerGithubWebhook(app, sql, config, githubApp);

  return app;
}
