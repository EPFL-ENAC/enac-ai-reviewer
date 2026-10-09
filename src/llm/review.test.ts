import { describe, expect, it } from 'vitest';
import type { LanguageModelV1 } from 'ai';
import {
  generateReview,
  ReviewResultSchema,
  ReviewTurnSchema,
  type FileFetcher,
  type ReviewAgentEvent,
} from './review.js';

function fakeModel(responses: unknown[]): LanguageModelV1 {
  let call = 0;
  return {
    specificationVersion: 'v1',
    provider: 'fake',
    modelId: 'fake-model',
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return {
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5 },
        text: JSON.stringify(response),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
    doStream: async () => {
      throw new Error('doStream not implemented');
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
      { type: 'files_requested', turn: 1, paths: ['src/domain/types.ts'], reason: 'check the interface' },
      {
        type: 'files_fetched',
        turn: 1,
        files: [{ path: 'src/domain/types.ts', status: 'fetched', chars: fileContent.length }],
        charsAdded: fileContent.length,
        totalChars: fileContent.length,
      },
    ]);
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

    expect(outcome.prompt).toContain('These files could not be fetched: missing.ts (not_found)');
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
    expect(() => ReviewTurnSchema.parse({ action: 'request_files', paths: [] })).toThrow();
    expect(() => ReviewTurnSchema.parse({ action: 'unknown_action' })).toThrow();
    expect(() => ReviewResultSchema.parse({ summary: 's' })).toThrow();
  });
});
