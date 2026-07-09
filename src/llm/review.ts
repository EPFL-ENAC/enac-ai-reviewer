import { generateObject } from 'ai';
import { z } from 'zod';
import type { LlmModel } from './client.js';

export const ReviewFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']),
  confidence: z.enum(['low', 'medium', 'high']),
  body: z.string(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(ReviewFindingSchema).max(20),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface ReviewInput {
  title: string;
  body: string;
  diff: string;
}

export interface ReviewOutcome {
  result: ReviewResult;
  inputTokens: number;
  outputTokens: number;
}

function buildPrompt(input: ReviewInput): string {
  return `You are a conservative code reviewer commenting on a GitHub pull request. Only comment on lines that
actually appear in the diff below — never invent a line number. For each finding, set "side" to RIGHT if you're
pointing at the new (added/context) version of the line, or LEFT if you're specifically pointing at a removed line.
Only raise findings you're reasonably confident about; skip nitpicks and anything a linter would already catch
(formatting, missing semicolons, import order). Do not comment on lock files or generated files.

Respond with:
- summary: 1-3 sentence overview of the review
- findings: array of specific issues, each with path, line, side, confidence, and body (the comment text)

PR title: ${input.title}

PR description:
${input.body || '(no description provided)'}

Diff (lock files and generated files already excluded):
${input.diff}`;
}

export async function generateReview(model: LlmModel, input: ReviewInput): Promise<ReviewOutcome> {
  const { object, usage } = await generateObject({
    model,
    schema: ReviewResultSchema,
    prompt: buildPrompt(input),
  });

  return {
    result: object,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  };
}
