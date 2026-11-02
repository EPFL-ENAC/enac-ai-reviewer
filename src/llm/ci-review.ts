import { z } from 'zod';
import { generateStructured, type LlmCallOptions, type LlmModel } from './client.js';
import type { LlmEventListener } from './events.js';
import { excerptReasoning } from './events.js';
import type { CiContext } from '../github/fetch-ci.js';

export const CiReviewResultSchema = z.object({
  problem: z.string().describe('One-sentence statement of what failed'),
  rootCause: z.string().describe('What actually broke and why, based on the logs'),
  suggestedFix: z.string().describe('Concrete next step to fix it'),
});

export type CiReviewResult = z.infer<typeof CiReviewResultSchema>;

export interface CiReviewOutcome {
  result: CiReviewResult;
  prompt: string;
  inputTokens: number;
  outputTokens: number;
}

function formatChecks(ci: CiContext): string {
  return ci.checkRuns
    .map((c) => `- ${c.name}: ${c.conclusion ?? c.status}`)
    .join('\n');
}

function formatLogs(ci: CiContext): string {
  if (ci.failedLogs.length === 0) return '(no downloadable logs — diagnose from the check names above)';
  return ci.failedLogs
    .map((l) => `--- Job: ${l.jobName}${l.failedStep ? ` (failed step: ${l.failedStep})` : ''} ---\n${l.log}`)
    .join('\n\n');
}

function buildPrompt(ci: CiContext): string {
  return `A pull request's CI failed. Diagnose the failure from the check runs and logs below. Respond with:
- problem: one sentence stating what failed
- rootCause: what actually broke and why, citing evidence from the logs (quote the key error line)
- suggestedFix: the concrete next step to fix it

CI check runs:
${formatChecks(ci)}

Logs of failed jobs:
${formatLogs(ci)}`;
}

export async function generateCiReview(
  model: LlmModel,
  ci: CiContext,
  onEvent?: LlmEventListener,
  options?: LlmCallOptions,
): Promise<CiReviewOutcome> {
  const prompt = buildPrompt(ci);
  await onEvent?.({ type: 'llm_prompt', prompt });
  const { object, usage, reasoning } = await generateStructured(model, CiReviewResultSchema, prompt, options);
  await onEvent?.({
    type: 'llm_response',
    result: object,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    ...excerptReasoning(reasoning),
  });

  return {
    result: object,
    prompt,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  };
}

export function formatCiReviewComment(result: CiReviewResult): string {
  return `### CI review

**Problem:** ${result.problem}

**Root cause:** ${result.rootCause}

**Suggested fix:** ${result.suggestedFix}`;
}

export const CI_PASSED_MESSAGE = '✅ CI passed: nothing to do.';
