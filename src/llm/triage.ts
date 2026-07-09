import { generateObject } from 'ai';
import { z } from 'zod';
import type { LlmModel } from './client.js';

export const TriageResultSchema = z.object({
  likelyType: z.enum(['bug', 'feature', 'question', 'docs', 'other']),
  confidence: z.enum(['low', 'medium', 'high']),
  missingInformation: z.array(z.string()).max(10),
  suggestedLabels: z.array(z.string()).max(5),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

export interface TriageInput {
  title: string;
  body: string;
  existingLabels: string[];
  comments: { author: string; body: string }[];
}

export interface TriageOutcome {
  result: TriageResult;
  inputTokens: number;
  outputTokens: number;
}

function buildPrompt(input: TriageInput): string {
  const comments = input.comments.length
    ? input.comments.map((c) => `${c.author}: ${c.body}`).join('\n')
    : '(no comments yet)';

  return `You are triaging a GitHub issue for a software project. Read the issue and respond with:
- likelyType: your best guess at the issue category
- confidence: how confident you are in that guess
- missingInformation: specific details someone would need to act on this issue (e.g. "steps to reproduce", "expected vs actual behavior", "browser/version") — empty array if the issue is already well-specified
- suggestedLabels: up to 5 short label suggestions

Issue title: ${input.title}

Issue body:
${input.body || '(no description provided)'}

Existing labels: ${input.existingLabels.join(', ') || 'none'}

Recent comments:
${comments}`;
}

export async function generateTriage(model: LlmModel, input: TriageInput): Promise<TriageOutcome> {
  const { object, usage } = await generateObject({
    model,
    schema: TriageResultSchema,
    prompt: buildPrompt(input),
  });

  return {
    result: object,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  };
}

export function formatTriageComment(result: TriageResult): string {
  const missing = result.missingInformation.length
    ? result.missingInformation.map((item) => `- ${item}`).join('\n')
    : '- (none — issue looks well-specified)';
  const labels = result.suggestedLabels.length ? result.suggestedLabels.map((l) => `- ${l}`).join('\n') : '- (none)';

  return `### AI triage

Likely type: ${result.likelyType}
Confidence: ${result.confidence}

Missing information:
${missing}

Suggested labels:
${labels}`;
}
