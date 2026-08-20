import { z } from 'zod';

function parseEnvBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return true;
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') return false;
  }
  return defaultValue;
}

const envBoolean = (defaultValue: boolean) =>
  z.union([z.boolean(), z.string()]).default(defaultValue).transform((value) => parseEnvBoolean(value, defaultValue));

const webSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORGANIZATIONS: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_AUTH_ENABLED: envBoolean(true),
  ADMIN_AUTH_HEADER_USER: z.string().default('X-Auth-Request-User'),
  ADMIN_AUTH_HEADER_EMAIL: z.string().optional(),
  ADMIN_AUTH_USERS: z.string().optional(),
  TRUST_PROXY: envBoolean(false),
});

const workerSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().min(1),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
});

export type WebConfig = z.infer<typeof webSchema> & {
  allowedOrganizations: string[];
  adminAuthUsers: string[];
};
export type WorkerConfig = z.infer<typeof workerSchema>;

function splitAllowlist(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = webSchema.parse(env);
  return {
    ...parsed,
    allowedOrganizations: splitAllowlist(parsed.ALLOWED_ORGANIZATIONS),
    adminAuthUsers: splitAllowlist(parsed.ADMIN_AUTH_USERS ?? ''),
  };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(env);
}
