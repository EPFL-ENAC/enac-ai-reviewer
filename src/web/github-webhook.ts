import type { App } from '@octokit/app';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { enqueueJob, insertDelivery } from '../db/jobs.js';
import type { Sql } from '../db/pool.js';
import type { WebConfig } from '../domain/config.js';
import { getInstallationOctokitForOrg, isOrgMember } from '../github/auth.js';
import { mapWebhookEvent } from '../github/map-event.js';
import { verifyWebhookSignature } from '../github/verify-webhook-signature.js';
import { jobsCreatedTotal, webhookRejectedTotal, webhookReceivedTotal } from './metrics.js';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: Buffer;
}

interface WebhookPayload {
  action?: string;
  repository?: {
    full_name: string;
    owner: { login: string; type?: string };
  };
}

export function registerGithubWebhook(
  app: FastifyInstance,
  sql: Sql,
  config: WebConfig,
  githubApp: App,
): void {
  app.post('/webhooks/github', async (request, reply) => {
    webhookReceivedTotal.inc();

    const rawBody = (request as RawBodyRequest).rawBody;
    const signature = request.headers['x-hub-signature-256'];
    if (!rawBody || typeof signature !== 'string' || !verifyWebhookSignature(config.GITHUB_WEBHOOK_SECRET, rawBody, signature)) {
      webhookRejectedTotal.inc({ reason: 'invalid_signature' });
      return reply.code(401).send();
    }

    const deliveryId = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof deliveryId !== 'string' || typeof event !== 'string') {
      webhookRejectedTotal.inc({ reason: 'missing_headers' });
      return reply.code(400).send();
    }

    const payload = request.body as WebhookPayload;
    const repositoryFullName = payload.repository?.full_name;

    const isNewDelivery = await insertDelivery(sql, {
      deliveryId,
      event,
      action: payload.action,
      repositoryFullName,
    });
    if (!isNewDelivery) {
      request.log.info({ deliveryId }, 'duplicate webhook delivery, ignoring');
      return reply.code(200).send();
    }

    const orgLogin = payload.repository?.owner.login;
    const orgType = payload.repository?.owner.type;

    // Also rejects if owner.type is undefined, since we only want to allow organizations. This is a safety measure in case GitHub changes the payload format in the future.
    if (!orgLogin || orgType !== 'Organization' || !config.allowedOrganizations.includes(orgLogin)) {
      webhookRejectedTotal.inc({ reason: 'organization_not_allowed' });
      request.log.info(
        { event, repositoryFullName, orgLogin, orgType },
        'organization not allowed, ignoring webhook',
      );
      return reply.code(204).send();
    }

    const trigger = mapWebhookEvent(event, deliveryId, config.GITHUB_BOT_LOGIN, payload);
    if (!trigger) {
      request.log.info({ event, action: payload.action, repositoryFullName }, 'no trigger matched, ignoring webhook');
      return reply.code(204).send();
    }

    try {
      const orgOctokit = await getInstallationOctokitForOrg(githubApp, orgLogin);
      const actorAllowed = await isOrgMember(orgOctokit, orgLogin, trigger.triggerActor);
      if (!actorAllowed) {
        webhookRejectedTotal.inc({ reason: 'actor_not_in_organization' });
        request.log.info(
          { event, repositoryFullName, orgLogin, actor: trigger.triggerActor },
          'trigger actor is not an organization member, ignoring webhook',
        );
        return reply.code(204).send();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;
      const isConfigError = status === 401 || status === 403;

      webhookRejectedTotal.inc({ reason: 'membership_check_failed' });
      if (isConfigError) {
        request.log.error(
          { err: message, status, orgLogin, actor: trigger.triggerActor },
          'failed to check organization membership due to configuration error',
        );
        return reply.code(500).send();
      }

      request.log.warn({ err: message, status, orgLogin, actor: trigger.triggerActor }, 'failed to check organization membership');
      return reply.code(204).send();
    }

    const job = await enqueueJob(sql, {
      provider: 'github',
      type: trigger.jobType,
      repositoryFullName: trigger.repositoryFullName,
      issueNumber: trigger.issueNumber,
      changeRequestNumber: trigger.changeRequestNumber,
      headSha: trigger.headSha,
      triggerActor: trigger.triggerActor,
      dedupeKey: trigger.dedupeKey,
      payload: trigger.payload,
    });

    if (job) {
      jobsCreatedTotal.inc({ job_type: trigger.jobType });
      request.log.info({ jobId: job.id, jobType: job.type, repositoryFullName }, 'job enqueued');
    } else {
      request.log.info(
        { jobType: trigger.jobType, repositoryFullName, dedupeKey: trigger.dedupeKey },
        'job deduplicated, not enqueued',
      );
    }

    return reply.code(202).send();
  });
}
