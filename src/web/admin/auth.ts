import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebConfig } from '../../domain/config.js';

export interface AdminUser {
  user: string;
  email?: string;
}

export function getAdminUser(request: FastifyRequest, config: WebConfig): AdminUser | null {
  if (!config.ADMIN_AUTH_ENABLED) {
    return { user: 'admin' };
  }

  const headerValue = request.headers[config.ADMIN_AUTH_HEADER_USER.toLowerCase()];
  const user = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!user) {
    return null;
  }

  const emailHeader = config.ADMIN_AUTH_HEADER_EMAIL;
  const emailValue = emailHeader ? request.headers[emailHeader.toLowerCase()] : undefined;
  const email = emailValue ? (Array.isArray(emailValue) ? emailValue[0] : emailValue) : undefined;

  return { user, email };
}

export function isAdminUserAllowed(user: AdminUser, config: WebConfig): boolean {
  if (config.adminAuthUsers.length === 0) {
    return true;
  }
  const candidates = [user.user, user.email].filter(Boolean) as string[];
  return candidates.some((candidate) => config.adminAuthUsers.includes(candidate));
}

export function requireAdminUser(
  request: FastifyRequest,
  reply: FastifyReply,
  config: WebConfig,
): AdminUser | null {
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
