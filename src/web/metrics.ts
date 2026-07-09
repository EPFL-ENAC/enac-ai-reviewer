import { Counter, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const webhookReceivedTotal = new Counter({
  name: 'webhook_received_total',
  help: 'Total GitHub webhook deliveries received',
  registers: [registry],
});

export const webhookRejectedTotal = new Counter({
  name: 'webhook_rejected_total',
  help: 'Total GitHub webhook deliveries rejected before enqueueing',
  labelNames: ['reason'],
  registers: [registry],
});

export const jobsCreatedTotal = new Counter({
  name: 'jobs_created_total',
  help: 'Total review jobs enqueued',
  labelNames: ['job_type'],
  registers: [registry],
});
