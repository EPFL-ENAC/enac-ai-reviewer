import type { App } from '@octokit/app';
import Fastify, { type FastifyInstance } from 'fastify';
import secureSession from '@fastify/secure-session';
import { createHash } from 'crypto';
import { registerAdminUi } from './admin/routes.js';
import type { Sql } from '../db/pool.js';
import type { WebConfig } from '../domain/config.js';
import { registerGithubWebhook } from './github-webhook.js';
import { registry } from './metrics.js';
import { createKeycloakAuth, type KeycloakAuth } from './admin/keycloak.js';

function deriveSessionSalt(secret: string): Buffer {
  return createHash('sha256').update(secret).digest().subarray(0, 16);
}

function sessionSalt(config: WebConfig): Buffer {
  if (config.SESSION_SALT) {
    return Buffer.from(config.SESSION_SALT, 'utf8').subarray(0, 16);
  }
  return deriveSessionSalt(config.SESSION_SECRET!);
}

export async function buildApp(
  sql: Sql,
  config: WebConfig,
  githubApp: App,
  injectedKeycloakAuth?: KeycloakAuth | null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: config.TRUST_PROXY });

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

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      const result: Record<string, string> = {};
      for (const [key, value] of params) {
        result[key] = value;
      }
      done(null, result);
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  let keycloakAuth: KeycloakAuth | null = null;
  if (config.ADMIN_AUTH_ENABLED && config.ADMIN_AUTH_MODE === 'keycloak') {
    await app.register(secureSession, {
      secret: config.SESSION_SECRET!,
      salt: sessionSalt(config),
      expiry: 24 * 60 * 60,
      cookie: {
        path: '/',
        httpOnly: true,
        secure: config.COOKIE_SECURE ?? true,
        sameSite: 'lax',
      },
    });
    keycloakAuth = injectedKeycloakAuth ?? (await createKeycloakAuth(config));
  }

  registerGithubWebhook(app, sql, config, githubApp);
  await registerAdminUi(app, sql, config, keycloakAuth);

  return app;
}
