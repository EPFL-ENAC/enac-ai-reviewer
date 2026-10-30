import { describe, expect, it } from 'vitest';
import type { LanguageModelV4, LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import {
  generateReview,
  ReviewResultSchema,
  ReviewTurnSchema,
  type FileFetcher,
  type ReviewAgentEvent,
} from './review.js';

const fakeUsage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function fakeModel(responses: unknown[], options?: { reasoning?: string }): LanguageModelV4 {
  let call = 0;
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not used by generateReview');
    },
    doStream: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (options?.reasoning) {
        parts.push(
          { type: 'reasoning-start', id: 'r' },
          { type: 'reasoning-delta', id: 'r', delta: options.reasoning },
          { type: 'reasoning-end', id: 'r' },
        );
      }
      parts.push(
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: JSON.stringify(response) },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: fakeUsage },
      );
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

const baseInput = { title: 't', body: 'b', diff: 'd' };

function fetcherFromMap(map: Record<string, string>): FileFetcher {
  return async (paths) => {
    const results = new Map();
    for (const path of paths) {
      const content = map[path];
      results.set(path, content != null ? { status: 'fetched', content } : { status: 'not_found' });
    }
    return results;
  };
}

describe('generateReview without fetchFiles (single-shot)', () => {
  it('keeps the plain review schema and reports no agent activity', async () => {
    const outcome = await generateReview(fakeModel([{ summary: 's', findings: [] }]), baseInput);

    expect(outcome.result).toEqual({ summary: 's', findings: [] });
    expect(outcome.agentTurns).toBe(0);
    expect(outcome.requestedPaths).toEqual([]);
    expect(outcome.fileChars).toBe(0);
    expect(outcome.inputTokens).toBe(10);
    expect(outcome.outputTokens).toBe(5);
    expect(outcome.prompt).toContain('Respond with:');
    expect(outcome.prompt).not.toContain('File request protocol');
  });
});

describe('generateReview effort handling', () => {
  it('low effort disables the agent even when a file fetcher is provided', async () => {
    const outcome = await generateReview(
      fakeModel([{ summary: 's', findings: [] }]),
      { ...baseInput, effort: 'low' },
      async () => {
        throw new Error('low effort must not fetch files');
      },
    );

    expect(outcome.result).toEqual({ summary: 's', findings: [] });
    expect(outcome.agentTurns).toBe(0);
    expect(outcome.requestedPaths).toEqual([]);
    expect(outcome.fileChars).toBe(0);
    expect(outcome.prompt).toContain('Review effort: low');
    expect(outcome.prompt).not.toContain('File request protocol');
  });

  it('high effort allows more request turns than medium', async () => {
    const request = { action: 'request_files' as const, paths: ['src/a.ts'] };
    const outcome = await generateReview(
      fakeModel([request, request, request, request, { action: 'submit_review', summary: 'ok', findings: [] }]),
      { ...baseInput, effort: 'high' },
      fetcherFromMap({}),
    );

    expect(outcome.agentTurns).toBe(4);
    expect(outcome.requestedPaths).toEqual(['src/a.ts', 'src/a.ts', 'src/a.ts', 'src/a.ts']);
    expect(outcome.result).toEqual({ summary: 'ok', findings: [] });
    expect(outcome.prompt).toContain(`You have at most 5 file request turns.`);
  });
});

describe('generateReview agent loop', () => {
  it('fetches requested files, appends them to the prompt and submits', async () => {
    const events: ReviewAgentEvent[] = [];
    const fileContent = 'export interface Foo {}';

    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['src/domain/types.ts'], reason: 'check the interface' },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      fetcherFromMap({ 'src/domain/types.ts': fileContent }),
      (event) => {
        events.push(event);
      },
    );

    expect(outcome.result).toEqual({ summary: 'ok', findings: [] });
    expect(outcome.agentTurns).toBe(1);
    expect(outcome.requestedPaths).toEqual(['src/domain/types.ts']);
    expect(outcome.fileChars).toBe(fileContent.length);
    expect(outcome.inputTokens).toBe(20);
    expect(outcome.outputTokens).toBe(10);
    expect(outcome.prompt).toContain('File request protocol');
    expect(outcome.prompt).toContain(`--- src/domain/types.ts ---`);
    expect(outcome.prompt).toContain(fileContent);

    expect(events).toEqual([
      { type: 'llm_prompt', prompt: expect.stringContaining('PR title: t') },
      {
        type: 'llm_response',
        result: { action: 'request_files', paths: ['src/domain/types.ts'], reason: 'check the interface' },
        inputTokens: 10,
        outputTokens: 5,
        reasoningText: '',
        reasoningChars: 0,
      },
      { type: 'files_requested', turn: 1, paths: ['src/domain/types.ts'], reason: 'check the interface' },
      {
        type: 'files_fetched',
        turn: 1,
        files: [{ path: 'src/domain/types.ts', status: 'fetched', chars: fileContent.length }],
        charsAdded: fileContent.length,
        totalChars: fileContent.length,
      },
      { type: 'llm_prompt', prompt: expect.stringContaining('Additional files you requested') },
      {
        type: 'llm_response',
        result: { action: 'submit_review', summary: 'ok', findings: [] },
        inputTokens: 10,
        outputTokens: 5,
        reasoningText: '',
        reasoningChars: 0,
      },
    ]);
  });

  it('forwards the model thinking in llm_response events', async () => {
    const events: unknown[] = [];

    await generateReview(
      fakeModel([{ summary: 'ok', findings: [] }], { reasoning: 'Weighing the severity of each finding.' }),
      baseInput,
      undefined,
      (event) => {
        events.push(event);
      },
    );

    expect(events).toContainEqual({
      type: 'llm_response',
      result: { summary: 'ok', findings: [] },
      inputTokens: 10,
      outputTokens: 5,
      reasoningText: 'Weighing the severity of each finding.',
      reasoningChars: 'Weighing the severity of each finding.'.length,
    });
  });

  it('rescues a request turn whose paths arrived as a JSON-encoded string', async () => {
    const fileContent = 'export interface Foo {}';

    const outcome = await generateReview(
      fakeModel([
        {
          action: 'request_files',
          paths: '["src/domain/types.ts", "src/llm/review.ts"]',
          reason: 'the diff is truncated',
        },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      fetcherFromMap({ 'src/domain/types.ts': fileContent, 'src/llm/review.ts': 'export const x = 1' }),
    );

    expect(outcome.result).toEqual({ summary: 'ok', findings: [] });
    expect(outcome.agentTurns).toBe(1);
    expect(outcome.requestedPaths).toEqual(['src/domain/types.ts', 'src/llm/review.ts']);
    expect(outcome.prompt).toContain('--- src/domain/types.ts ---');
    expect(outcome.prompt).toContain(fileContent);
  });

  it('rescues a submit turn whose findings arrived as a JSON-encoded string', async () => {
    const finding = {
      path: 'src/github/fetch-context.ts',
      line: 147,
      side: 'RIGHT',
      confidence: 'high',
      body: 'use Buffer.byteLength for byte-accurate budgets',
    };

    const outcome = await generateReview(
      fakeModel([{ action: 'submit_review', summary: 'ok', findings: JSON.stringify([finding]) }]),
      baseInput,
    );

    expect(outcome.result).toEqual({ summary: 'ok', findings: [finding] });
    expect(outcome.agentTurns).toBe(0);
  });

  it('does not re-fetch a path that was already provided', async () => {
    const calls: string[][] = [];
    const countingFetcher: FileFetcher = async (paths) => {
      calls.push(paths);
      return fetcherFromMap({ 'a.ts': 'content a' })(paths);
    };

    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['a.ts'] },
        { action: 'request_files', paths: ['./a.ts'] },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      countingFetcher,
    );

    expect(calls).toEqual([['a.ts']]);
    expect(outcome.agentTurns).toBe(2);
    expect(outcome.fileChars).toBe('content a'.length);
    expect(outcome.prompt).toContain('Already provided in a previous turn: a.ts');
  });

  it('notes files that could not be fetched', async () => {
    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['missing.ts'] },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      fetcherFromMap({}),
    );

    expect(outcome.prompt).toContain('These files could not be fetched: missing.ts (not found at the PR head commit)');
  });

  it('explains why a file could not be fetched instead of the raw status code', async () => {
    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['big.ts', 'lock.json'] },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      async () =>
        new Map([
          ['big.ts', { status: 'too_large' }],
          ['lock.json', { status: 'skipped_generated' }],
        ]),
    );

    expect(outcome.prompt).toContain('big.ts (over the 40,000-character per-file limit');
    expect(outcome.prompt).toContain('request a smaller file instead');
    expect(outcome.prompt).toContain('lock.json (generated or lock file, skipped)');
  });

  it('states the file request limits in the prompt', async () => {
    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['a.ts'] },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      fetcherFromMap({ 'a.ts': 'a' }),
    );

    expect(outcome.prompt).toContain('you may request up to 5');
    expect(outcome.prompt).toContain('40,000 characters per file and');
    expect(outcome.prompt).toContain('120,000 characters across all turns');
    expect(outcome.prompt).toContain('instead of re-requesting a rejected one');
  });

  it('drops invalid paths and reports them', async () => {
    const calls: string[][] = [];
    const countingFetcher: FileFetcher = async (paths) => {
      calls.push(paths);
      return fetcherFromMap({ 'ok.ts': 'ok' })(paths);
    };

    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['../etc/passwd', '/absolute', 'ok.ts'] },
        { action: 'submit_review', summary: 'ok', findings: [] },
      ]),
      baseInput,
      countingFetcher,
    );

    expect(calls).toEqual([['ok.ts']]);
    expect(outcome.prompt).toContain('ok.ts');
    expect(outcome.prompt).toContain('could not be fetched');
  });

  it('forces a submit-only final call once the request-turn budget is exhausted', async () => {
    const outcome = await generateReview(
      fakeModel([
        { action: 'request_files', paths: ['a.ts'] },
        { action: 'request_files', paths: ['b.ts'] },
        { action: 'request_files', paths: ['c.ts'] },
        { summary: 'final', findings: [] },
      ]),
      baseInput,
      fetcherFromMap({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' }),
    );

    expect(outcome.agentTurns).toBe(3);
    expect(outcome.result).toEqual(ReviewResultSchema.parse({ summary: 'final', findings: [] }));
    expect(outcome.prompt).toContain('Submit your final review now');
    expect(outcome.fileChars).toBe(3);
    expect(outcome.inputTokens).toBe(40);
    expect(outcome.outputTokens).toBe(20);
  });

  it('validates the turn schema shapes', () => {
    expect(
      ReviewTurnSchema.parse({ action: 'request_files', paths: ['a.ts'], reason: 'r' }),
    ).toEqual({ action: 'request_files', paths: ['a.ts'], reason: 'r' });
    expect(ReviewTurnSchema.parse({ action: 'submit_review', summary: 's', findings: [] })).toEqual({
      action: 'submit_review',
      summary: 's',
      findings: [],
    });
    expect(ReviewTurnSchema.parse({ action: 'request_files', paths: '["a.ts"]' })).toEqual({
      action: 'request_files',
      paths: ['a.ts'],
    });
    expect(ReviewTurnSchema.parse({ action: 'request_files', paths: 'a.ts' })).toEqual({
      action: 'request_files',
      paths: ['a.ts'],
    });
    expect(
      ReviewTurnSchema.parse({
        action: 'submit_review',
        summary: 's',
        findings: '[{"path":"p.ts","line":1,"side":"RIGHT","confidence":"high","body":"b"}]',
      }),
    ).toEqual({
      action: 'submit_review',
      summary: 's',
      findings: [{ path: 'p.ts', line: 1, side: 'RIGHT', confidence: 'high', body: 'b' }],
    });
    expect(() => ReviewTurnSchema.parse({ action: 'request_files', paths: [] })).toThrow();
    expect(() => ReviewTurnSchema.parse({ action: 'request_files', paths: '' })).toThrow();
    expect(() => ReviewTurnSchema.parse({ action: 'unknown_action' })).toThrow();
    expect(() => ReviewResultSchema.parse({ summary: 's' })).toThrow();
  });
});
