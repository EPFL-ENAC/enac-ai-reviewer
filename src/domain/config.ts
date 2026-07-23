import { z } from 'zod';

const webSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORGANIZATIONS: z.string().min(1),
  GITHUB_BOT_LOGIN: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
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

export type WebConfig = z.infer<typeof webSchema> & { allowedOrganizations: string[] };
export type WorkerConfig = z.infer<typeof workerSchema>;

function splitAllowlist(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = webSchema.parse(env);
  return { ...parsed, allowedOrganizations: splitAllowlist(parsed.ALLOWED_ORGANIZATIONS) };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(env);
}
