import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { WebConfig } from '../../domain/config.js';
import { createKeycloakAuth, type KeycloakAuth } from './keycloak.js';

interface FakeOidcProvider {
  server: Server;
  baseUrl: string;
  issuerUrl: string;
}

function base64UrlEncode(input: Buffer): string {
  return input.toString('base64url');
}

function createJwt(payload: Record<string, unknown>, privateKey: KeyObject, keyId: string): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

async function startFakeOidcProvider(): Promise<FakeOidcProvider> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const keyId = 'test-key';

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      res.setHeader('Content-Type', 'application/json');
      const issuerUrl = `http://${req.headers.host}/realms/test-realm`;

      if (url.pathname === '/realms/test-realm/.well-known/openid-configuration') {
        res.end(
          JSON.stringify({
            issuer: issuerUrl,
            authorization_endpoint: `${issuerUrl}/auth`,
            token_endpoint: `${issuerUrl}/token`,
            end_session_endpoint: `${issuerUrl}/logout`,
            jwks_uri: `${issuerUrl}/jwks`,
          }),
        );
        return;
      }

      if (url.pathname === '/realms/test-realm/jwks') {
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: keyId, use: 'sig', kty: 'RSA' }] }));
        return;
      }

      if (url.pathname === '/realms/test-realm/token' && req.method === 'POST') {
        const now = Math.floor(Date.now() / 1000);
        const idToken = createJwt(
          {
            iss: issuerUrl,
            sub: 'test-user',
            aud: 'test-client',
            exp: now + 3600,
            iat: now,
            nonce: 'test-nonce',
            preferred_username: 'test-user',
            email: 'test@example.com',
          },
          privateKey,
          keyId,
        );
        res.end(
          JSON.stringify({
            access_token: 'test-access-token',
            token_type: 'Bearer',
            id_token: idToken,
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      resolve({ server, baseUrl, issuerUrl: `${baseUrl}/realms/test-realm` });
    });
  });
}

function stopFakeOidcProvider(provider: FakeOidcProvider): Promise<void> {
  return new Promise((resolve) => {
    provider.server.close(() => resolve());
  });
}

function mockRequest(url?: string): FastifyRequest {
  const store = new Map<string, unknown>();
  return {
    protocol: 'http',
    hostname: 'localhost',
    url: url ?? '/admin/auth/callback?code=abc&state=xyz',
    session: {
      set(key: string, value: unknown) {
        store.set(key, value);
      },
      get(key: string) {
        return store.get(key);
      },
      delete() {
        store.clear();
      },
    },
  } as unknown as FastifyRequest;
}

function keycloakConfig(issuerUrl: string): WebConfig {
  return {
    PORT: 3000,
    GITHUB_WEBHOOK_SECRET: 'test',
    DATABASE_URL: 'postgres://test',
    ALLOWED_ORGANIZATIONS: 'EPFL-ENAC',
    GITHUB_BOT_LOGIN: 'bot',
    GITHUB_APP_ID: '1',
    GITHUB_PRIVATE_KEY: 'key',
    ADMIN_AUTH_ENABLED: true,
    ADMIN_AUTH_MODE: 'keycloak',
    ADMIN_AUTH_HEADER_USER: 'X-Auth-Request-User',
    ADMIN_AUTH_HEADER_EMAIL: 'X-Auth-Request-Email',
    KEYCLOAK_URL: issuerUrl,
    KEYCLOAK_REALM: 'test-realm',
    KEYCLOAK_CLIENT_ID: 'test-client',
    KEYCLOAK_CLIENT_SECRET: 'test-secret',
    KEYCLOAK_REDIRECT_URI: 'http://localhost/admin/auth/callback',
    SESSION_SECRET: 'a-very-long-session-secret-for-tests-32b',
    TRUST_PROXY: false,
    allowedOrganizations: ['EPFL-ENAC'],
    adminAuthUsers: [],
  } as WebConfig;
}

describe('createKeycloakAuth integration', () => {
  let provider: FakeOidcProvider;
  let auth: KeycloakAuth;

  beforeAll(async () => {
    provider = await startFakeOidcProvider();
    auth = await createKeycloakAuth(keycloakConfig(provider.baseUrl));
  });

  afterAll(async () => {
    await stopFakeOidcProvider(provider);
  });

  it('discovers the issuer and builds a login URL', async () => {
    const request = mockRequest();
    const loginUrl = auth.getLoginUrl(request, '/admin/jobs');

    expect(loginUrl).toContain(`${provider.issuerUrl}/auth`);
    expect(loginUrl).toContain('response_type=code');
    expect(loginUrl).toContain('scope=openid+email+profile');
    expect(loginUrl).toContain('redirect_uri=');
    expect(loginUrl).toContain('state=');
    expect(loginUrl).toContain('nonce=');
    expect(loginUrl).toContain('client_id=test-client');

    const login = new URL(loginUrl);
    expect(login.searchParams.get('redirect_uri')).toBe('http://localhost/admin/auth/callback');
    expect(request.session.get('oidcState')).toBe(login.searchParams.get('state'));
    expect(request.session.get('oidcNonce')).toBe(login.searchParams.get('nonce'));
    expect(request.session.get('oidcRedirectTo')).toBe('/admin/jobs');
  });

  it('exchanges the authorization code and returns the authenticated user', async () => {
    const request = mockRequest('/admin/auth/callback?code=abc&state=xyz');
    request.session.set('oidcState', 'xyz');
    request.session.set('oidcNonce', 'test-nonce');
    request.session.set('oidcRedirectTo', '/admin/jobs');

    const result = await auth.handleCallback(request);

    expect(result.user).toEqual({ user: 'test-user', email: 'test@example.com' });
    expect(result.redirectTo).toBe('/admin/jobs');
    expect(request.session.get('adminUser')).toEqual({ user: 'test-user', email: 'test@example.com' });
    expect(request.session.get('oidcState')).toBeUndefined();
    expect(request.session.get('oidcNonce')).toBeUndefined();
  });

  it('returns the user from the session', () => {
    const request = mockRequest();
    expect(auth.getUser(request)).toBeNull();

    request.session.set('adminUser', { user: 'alice', email: 'alice@example.com' });
    expect(auth.getUser(request)).toEqual({ user: 'alice', email: 'alice@example.com' });
  });

  it('builds a logout URL that clears the session', () => {
    const request = mockRequest();
    request.session.set('adminUser', { user: 'alice' });

    const logoutUrl = auth.getLogoutUrl(request);

    expect(logoutUrl).toContain(`${provider.issuerUrl}/logout`);
    expect(logoutUrl).toContain('post_logout_redirect_uri=');
    expect(request.session.get('adminUser')).toBeUndefined();
  });

  it('rejects a callback with a mismatched state', async () => {
    const request = mockRequest('/admin/auth/callback?code=abc&state=wrong');
    request.session.set('oidcState', 'xyz');
    request.session.set('oidcNonce', 'test-nonce');

    await expect(auth.handleCallback(request)).rejects.toThrow(/invalid response/);
  });

  it('rejects a callback with a mismatched nonce', async () => {
    const request = mockRequest('/admin/auth/callback?code=abc&state=xyz');
    request.session.set('oidcState', 'xyz');
    request.session.set('oidcNonce', 'wrong-nonce');

    await expect(auth.handleCallback(request)).rejects.toThrow(/unexpected JWT claim/);
  });
});
