import { generateObject } from 'ai';
import { z } from 'zod';
import type { LlmModel } from './client.js';

export const ExplainResultSchema = z.object({
  summary: z.string(),
  keyChanges: z.array(z.string()).max(10),
});

export type ExplainResult = z.infer<typeof ExplainResultSchema>;

export interface ExplainInput {
  title: string;
  body: string;
  diff: string;
}

export interface ExplainOutcome {
  result: ExplainResult;
  prompt: string;
  inputTokens: number;
  outputTokens: number;
}

function buildPrompt(input: ExplainInput): string {
  return `Explain this pull request in plain language for a reviewer who hasn't read the code yet. Respond with:
- summary: 2-4 sentences describing what this PR does and why, in plain language
- keyChanges: up to 10 short bullet points calling out the most notable individual changes

PR title: ${input.title}

PR description:
${input.body || '(no description provided)'}

Diff (lock files and generated files already excluded):
${input.diff}`;
}

export async function generateExplain(model: LlmModel, input: ExplainInput): Promise<ExplainOutcome> {
  const { object, usage } = await generateObject({
    model,
    schema: ExplainResultSchema,
    prompt: buildPrompt(input),
  });

  return {
    result: object,
    prompt: buildPrompt(input),
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  };
}

export function formatExplainComment(result: ExplainResult): string {
  const changes = result.keyChanges.length
    ? result.keyChanges.map((c) => `- ${c}`).join('\n')
    : '- (no notable individual changes)';

  return `### AI summary

${result.summary}

Key changes:
${changes}`;
}
