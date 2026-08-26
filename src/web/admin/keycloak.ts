import type { FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import type { WebConfig } from '../../domain/config.js';
import type { AdminUser } from './auth.js';

declare module '@fastify/secure-session' {
  interface SessionData {
    oidcState?: string;
    oidcNonce?: string;
    oidcRedirectTo?: string;
    adminUser?: AdminUser;
  }
}

export interface KeycloakAuth {
  getLoginUrl(request: FastifyRequest, redirectTo?: string): string;
  handleCallback(request: FastifyRequest): Promise<{ user: AdminUser; redirectTo: string }>;
  getUser(request: FastifyRequest): AdminUser | null;
  getLogoutUrl(request: FastifyRequest): string;
}

function appBaseUrlFromRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri);
  return `${url.protocol}//${url.host}`;
}

export async function createKeycloakAuth(config: WebConfig): Promise<KeycloakAuth> {
  const issuerUrl = new URL(`${config.KEYCLOAK_URL}/realms/${config.KEYCLOAK_REALM}`);
  const redirectUri = config.KEYCLOAK_REDIRECT_URI!;

  const oidcConfig = await client.discovery(
    issuerUrl,
    config.KEYCLOAK_CLIENT_ID!,
    { redirect_uris: [redirectUri] },
    client.ClientSecretPost(config.KEYCLOAK_CLIENT_SECRET!),
  );

  return {
    getLoginUrl(request, redirectTo = '/admin') {
      const state = client.randomState();
      const nonce = client.randomNonce();
      request.session.set('oidcState', state);
      request.session.set('oidcNonce', nonce);
      request.session.set('oidcRedirectTo', redirectTo);

      const url = client.buildAuthorizationUrl(oidcConfig, {
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
      });
      return url.toString();
    },

    async handleCallback(request) {
      const expectedState = request.session.get('oidcState');
      const expectedNonce = request.session.get('oidcNonce');
      const redirectTo = request.session.get('oidcRedirectTo') ?? '/admin';

      request.session.set('oidcState', undefined);
      request.session.set('oidcNonce', undefined);
      request.session.set('oidcRedirectTo', undefined);

      const currentUrl = new URL(`${request.protocol}://${request.hostname}${request.url}`);
      const tokens = await client.authorizationCodeGrant(oidcConfig, currentUrl, {
        expectedState,
        expectedNonce,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims) {
        throw new Error('Keycloak did not return an ID token');
      }

      const raw = claims as Record<string, unknown>;
      const user = typeof raw.preferred_username === 'string' ? raw.preferred_username : claims.sub;
      const email = typeof raw.email === 'string' ? raw.email : undefined;

      if (!user) {
        throw new Error('Keycloak did not return a user identifier');
      }

      const adminUser: AdminUser = { user, email };
      request.session.set('adminUser', adminUser);

      return { user: adminUser, redirectTo };
    },

    getUser(request) {
      return request.session.get('adminUser') ?? null;
    },

    getLogoutUrl(request) {
      request.session.delete();
      const metadata = oidcConfig.serverMetadata();
      if (metadata.end_session_endpoint) {
        const url = new URL(metadata.end_session_endpoint);
        url.searchParams.set('post_logout_redirect_uri', `${appBaseUrlFromRedirectUri(redirectUri)}/admin`);
        return url.toString();
      }
      return '/admin';
    },
  };
}
