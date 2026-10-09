import { generateObject } from 'ai';
import { z } from 'zod';
import type { LlmModel } from './client.js';
import { sanitizeRequestedPaths, type FileFetchResult } from '../github/fetch-context.js';

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

const MAX_AGENT_TURNS = 3;
const MAX_REQUESTED_FILES_PER_TURN = 5;

export const FilesRequestTurnSchema = z.object({
  action: z.literal('request_files'),
  paths: z.array(z.string()).min(1).max(MAX_REQUESTED_FILES_PER_TURN),
  reason: z.string().optional(),
});

export type FilesRequestTurn = z.infer<typeof FilesRequestTurnSchema>;

export const SubmitTurnSchema = z.object({
  action: z.literal('submit_review'),
  summary: z.string(),
  findings: z.array(ReviewFindingSchema).max(20),
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
    };

export type ReviewAgentEventListener = (event: ReviewAgentEvent) => void | Promise<void>;

function buildPrompt(input: ReviewInput, agent = false): string {
  const effort = input.effort ?? 'medium';

  const sections: string[] = [
    `You are a conservative code reviewer commenting on a GitHub pull request. Only comment on lines that
actually appear in the diff below — never invent a line number. For each finding, set "side" to RIGHT if you're
pointing at the new (added/context) version of the line, or LEFT if you're specifically pointing at a removed line.
Only raise findings you're reasonably confident about; skip nitpicks and anything a linter would already catch
(formatting, missing semicolons, import order). Do not comment on lock files or generated files.

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
by changed files, interface definitions, callers, tests. Respond with
{"action":"request_files","paths":["..."],"reason":"..."}. When ready, or when you have no more useful requests, respond
with {"action":"submit_review","summary":"...","findings":[...]}. You have at most ${MAX_AGENT_TURNS} file request turns.
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
): Promise<ReviewOutcome> {
  if (!fetchFiles) {
    const prompt = buildPrompt(input);
    const { object, usage } = await generateObject({
      model,
      schema: ReviewResultSchema,
      prompt,
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
    if (agentTurns >= MAX_AGENT_TURNS) {
      const forcedPrompt = `${prompt}\n\nYou have used all ${MAX_AGENT_TURNS} file request turns and no further files
can be provided. Submit your final review now.`;
      const { object, usage } = await generateObject({
        model,
        schema: ReviewResultSchema,
        prompt: forcedPrompt,
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

    const { object: turn, usage } = await generateObject({
      model,
      schema: ReviewTurnSchema,
      prompt,
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
      unavailable.push(`${path} (${result.status})`);
      files.push({ path, status: result.status });
    }
  }
  for (const path of invalid) {
    unavailable.push(`${path} (invalid)`);
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
