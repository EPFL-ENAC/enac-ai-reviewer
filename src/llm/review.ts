import { z } from 'zod';
import { generateStructured, type LlmCallOptions, type LlmModel } from './client.js';
import type { LlmEvent } from './events.js';
import {
  MAX_AGENT_FILE_CHARS,
  MAX_AGENT_TOTAL_FILE_CHARS,
  sanitizeRequestedPaths,
  type FileFetchResult,
} from '../github/fetch-context.js';

export const ReviewFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  side: z.enum(['LEFT', 'RIGHT']),
  confidence: z.enum(['low', 'medium', 'high']),
  body: z.string(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

function coerceStringToArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  let parsed: unknown = null;
  if (trimmed.startsWith('[')) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
  }
  if (Array.isArray(parsed)) return parsed;
  return trimmed.length > 0 ? [trimmed] : value;
}

export const ReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.preprocess(coerceStringToArray, z.array(ReviewFindingSchema).max(20)),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export interface ReviewInput {
  title: string;
  body: string;
  diff: string;
  effort?: 'low' | 'medium' | 'high';
  context?: string;
  prompt?: string;
}

export interface ReviewOutcome {
  result: ReviewResult;
  prompt: string;
  inputTokens: number;
  outputTokens: number;
  agentTurns: number;
  requestedPaths: string[];
  fileChars: number;
}

/**
 * Programmatic effect of the `--effort` command arg (kept in the prompt too).
 * `low` disables the file-request agent entirely (single-shot diff review);
 * `high` buys more agent turns for deeper file exploration.
 */
const AGENT_TURNS_BY_EFFORT: Record<NonNullable<ReviewInput['effort']>, number> = {
  low: 0,
  medium: 3,
  high: 5,
};
const MAX_REQUESTED_FILES_PER_TURN = 5;

function formatChars(chars: number): string {
  return chars.toLocaleString('en-US');
}

function describeFileStatus(status: FileFetchResult['status']): string {
  switch (status) {
    case 'fetched':
      return 'fetched';
    case 'not_found':
      return 'not found at the PR head commit';
    case 'binary_skipped':
      return 'binary file, skipped';
    case 'too_large':
      return `over the ${formatChars(MAX_AGENT_FILE_CHARS)}-character per-file limit — request a smaller file instead`;
    case 'skipped_generated':
      return 'generated or lock file, skipped';
    case 'budget_exhausted':
      return `the ${formatChars(MAX_AGENT_TOTAL_FILE_CHARS)}-character total file budget is exhausted — no further files can be provided`;
  }
}

export const FilesRequestTurnSchema = z.object({
  action: z.literal('request_files'),
  paths: z.preprocess(coerceStringToArray, z.array(z.string()).min(1).max(MAX_REQUESTED_FILES_PER_TURN)),
  reason: z.string().optional(),
});

export type FilesRequestTurn = z.infer<typeof FilesRequestTurnSchema>;

export const SubmitTurnSchema = z.object({
  action: z.literal('submit_review'),
  summary: z.string(),
  findings: z.preprocess(coerceStringToArray, z.array(ReviewFindingSchema).max(20)),
});

export type SubmitTurn = z.infer<typeof SubmitTurnSchema>;

export const ReviewTurnSchema = z.discriminatedUnion('action', [FilesRequestTurnSchema, SubmitTurnSchema]);

export type ReviewTurn = z.infer<typeof ReviewTurnSchema>;

export type FileFetcher = (paths: string[]) => Promise<Map<string, FileFetchResult>>;

export type ReviewAgentEvent =
  | { type: 'files_requested'; turn: number; paths: string[]; reason?: string }
  | {
      type: 'files_fetched';
      turn: number;
      files: { path: string; status: string; chars?: number }[];
      charsAdded: number;
      totalChars: number;
    }
  | LlmEvent;

export type ReviewAgentEventListener = (event: ReviewAgentEvent) => void | Promise<void>;

function buildPrompt(input: ReviewInput, agent = false): string {
  const effort = input.effort ?? 'medium';

  const sections: string[] = [
    `You are a conservative code reviewer commenting on a GitHub pull request. Only comment on lines that
actually appear in the diff below — never invent a line number. For each finding, set "side" to RIGHT if you're
pointing at the new (added/context) version of the line, or LEFT if you're specifically pointing at a removed line.
Only raise findings you're reasonably confident about; skip nitpicks and anything a linter would already catch
(formatting, missing semicolons, import order). Do not comment on lock files or generated files.
Keep each finding body under 120 words — precise and actionable, no restating the code.

Review effort: ${effort}`,
  ];

  if (input.context) {
    sections.push(`Additional context:\n${input.context}`);
  }

  if (input.prompt) {
    sections.push(`Additional instructions:\n${input.prompt}`);
  }

  if (agent) {
    sections.push(`File request protocol: before submitting your review, you may request up to ${MAX_REQUESTED_FILES_PER_TURN}
additional files from this repository (at the PR head commit) to make your review more accurate — e.g. modules imported
by changed files, interface definitions, callers, tests. Limits: ${formatChars(MAX_AGENT_FILE_CHARS)} characters per file and
${formatChars(MAX_AGENT_TOTAL_FILE_CHARS)} characters across all turns. Files over the per-file limit are rejected and cannot
be provided — request smaller or more specific files instead of re-requesting a rejected one. Respond with
{"action":"request_files","paths":["..."],"reason":"..."}. When ready, or when you have no more useful requests, respond
with {"action":"submit_review","summary":"...","findings":[...]}. You have at most ${AGENT_TURNS_BY_EFFORT[effort]} file request turns.
All findings must still reference lines that appear in the diff.`);
  } else {
    sections.push(`Respond with:
- summary: 1-3 sentence overview of the review
- findings: array of specific issues, each with path, line, side, confidence, and body (the comment text)`);
  }

  sections.push(`PR title: ${input.title}

PR description:
${input.body || '(no description provided)'}

Diff (lock files and generated files already excluded):
${input.diff}`);

  return sections.join('\n\n');
}

export async function generateReview(
  model: LlmModel,
  input: ReviewInput,
  fetchFiles?: FileFetcher,
  onEvent?: ReviewAgentEventListener,
  options?: LlmCallOptions,
): Promise<ReviewOutcome> {
  const maxAgentTurns = AGENT_TURNS_BY_EFFORT[input.effort ?? 'medium'];
  if (!fetchFiles || maxAgentTurns === 0) {
    const prompt = buildPrompt(input);
    await onEvent?.({ type: 'llm_prompt', prompt });
    const { object, usage } = await generateStructured(model, ReviewResultSchema, prompt, options);
    await onEvent?.({
      type: 'llm_response',
      result: object,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    });

    return {
      result: object,
      prompt,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      agentTurns: 0,
      requestedPaths: [],
      fileChars: 0,
    };
  }

  let prompt = buildPrompt(input, true);
  let inputTokens = 0;
  let outputTokens = 0;
  let agentTurns = 0;
  let fileChars = 0;
  const requestedPaths: string[] = [];
  const providedPaths = new Set<string>();

  for (;;) {
    if (agentTurns >= maxAgentTurns) {
      const forcedPrompt = `${prompt}\n\nYou have used all ${maxAgentTurns} file request turns and no further files
can be provided. Submit your final review now.`;
      await onEvent?.({ type: 'llm_prompt', prompt: forcedPrompt });
      const { object, usage } = await generateStructured(model, ReviewResultSchema, forcedPrompt, options);
      await onEvent?.({
        type: 'llm_response',
        result: object,
        inputTokens: usage.promptTokens,
        outputTokens: usage.completionTokens,
      });
      inputTokens += usage.promptTokens;
      outputTokens += usage.completionTokens;

      return {
        result: object,
        prompt: forcedPrompt,
        inputTokens,
        outputTokens,
        agentTurns,
        requestedPaths,
        fileChars,
      };
    }

    await onEvent?.({ type: 'llm_prompt', prompt });
    const { object: turn, usage } = await generateStructured(model, ReviewTurnSchema, prompt, options);
    await onEvent?.({
      type: 'llm_response',
      result: turn,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
    });
    inputTokens += usage.promptTokens;
    outputTokens += usage.completionTokens;

    if (turn.action === 'submit_review') {
      return {
        result: { summary: turn.summary, findings: turn.findings },
        prompt,
        inputTokens,
        outputTokens,
        agentTurns,
        requestedPaths,
        fileChars,
      };
    }

    agentTurns += 1;
    requestedPaths.push(...turn.paths);
    await onEvent?.({ type: 'files_requested', turn: agentTurns, paths: turn.paths, reason: turn.reason });

    const { section, charsAdded } = await requestFilesSection(
      turn,
      agentTurns,
      fetchFiles,
      providedPaths,
      fileChars,
      onEvent,
    );
    fileChars += charsAdded;
    prompt = `${prompt}\n\n${section}`;
  }
}

async function requestFilesSection(
  turn: FilesRequestTurn,
  turnNumber: number,
  fetchFiles: FileFetcher,
  providedPaths: Set<string>,
  totalCharsSoFar: number,
  onEvent?: ReviewAgentEventListener,
): Promise<{ section: string; charsAdded: number }> {
  const sanitized = sanitizeRequestedPaths(turn.paths);
  const sanitizedSet = new Set(sanitized);
  const invalid = turn.paths.filter((path) => !sanitizedSet.has(path));
  const duplicates: string[] = [];
  const toFetch: string[] = [];
  for (const path of sanitized) {
    if (providedPaths.has(path)) duplicates.push(path);
    else toFetch.push(path);
  }

  const results = toFetch.length > 0 ? await fetchFiles(toFetch) : new Map<string, FileFetchResult>();
  const contents: string[] = [];
  const unavailable: string[] = [];
  const files: { path: string; status: string; chars?: number }[] = [];
  let charsAdded = 0;

  for (const path of toFetch) {
    const result = results.get(path) ?? { status: 'not_found' as const };
    if (result.status === 'fetched') {
      providedPaths.add(path);
      charsAdded += result.content.length;
      contents.push(`--- ${path} ---\n${result.content}`);
      files.push({ path, status: 'fetched', chars: result.content.length });
    } else {
      unavailable.push(`${path} (${describeFileStatus(result.status)})`);
      files.push({ path, status: result.status });
    }
  }
  for (const path of invalid) {
    unavailable.push(`${path} (invalid path, rejected)`);
    files.push({ path, status: 'invalid' });
  }
  for (const path of duplicates) {
    files.push({ path, status: 'duplicate' });
  }

  const parts: string[] = [];
  if (contents.length > 0) {
    parts.push(`Additional files you requested:\n\n${contents.join('\n\n')}`);
  }
  if (unavailable.length > 0) {
    parts.push(`These files could not be fetched: ${unavailable.join(', ')}.`);
  }
  if (duplicates.length > 0) {
    parts.push(`Already provided in a previous turn: ${duplicates.join(', ')}.`);
  }

  await onEvent?.({
    type: 'files_fetched',
    turn: turnNumber,
    files,
    charsAdded,
    totalChars: totalCharsSoFar + charsAdded,
  });

  return { section: parts.join('\n\n'), charsAdded };
}
