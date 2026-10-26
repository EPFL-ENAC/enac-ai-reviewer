import { describe, expect, it } from 'vitest';
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { z } from 'zod';
import { generateStructured } from './client.js';

const fakeUsage: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function fakeStreamModel(options: { parts: LanguageModelV4StreamPart[]; close: boolean }): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not used by generateStructured');
    },
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          for (const part of options.parts) controller.enqueue(part);
          if (options.close) controller.close();
        },
      }),
    }),
  };
}

const schema = z.object({ summary: z.string() });
const jsonPart: LanguageModelV4StreamPart = {
  type: 'text-delta',
  id: '1',
  delta: JSON.stringify({ summary: 's' }),
};
const finishPart: LanguageModelV4StreamPart = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: fakeUsage };

describe('generateStructured stream safety', () => {
  it('resolves the validated object and usage on a well-formed stream', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'response-metadata', modelId: 'fake-model' },
      jsonPart,
      finishPart,
    ];
    const model = fakeStreamModel({ parts, close: true });

    const { object, usage } = await generateStructured(model, schema, 'p', { timeoutMs: 5000 });

    expect(object).toEqual({ summary: 's' });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('rejects instead of hanging when the stream ends without a finish event', async () => {
    const model = fakeStreamModel({ parts: [jsonPart], close: true });

    await expect(generateStructured(model, schema, 'p', { timeoutMs: 5000 })).rejects.toThrow(
      /ended without a completion event/,
    );
  });

  it('rejects on the time budget when the stream never ends', async () => {
    const model = fakeStreamModel({ parts: [jsonPart], close: false });

    await expect(generateStructured(model, schema, 'p', { timeoutMs: 50 })).rejects.toThrow(
      /exceeded its time budget/,
    );
  });

  it('surfaces in-stream gateway errors with their real cause', async () => {
    const model = fakeStreamModel({
      parts: [jsonPart, { type: 'error', error: { message: 'upstream exploded', code: 502 } }],
      close: true,
    });

    await expect(generateStructured(model, schema, 'p', { timeoutMs: 5000 })).rejects.toThrow(
      /upstream exploded/,
    );
  });

  it('explains a schema mismatch: finishReason, zod issues and raw output', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'text-delta', id: '1', delta: JSON.stringify({ summary: 42 }) },
      finishPart,
    ];
    const model = fakeStreamModel({ parts, close: true });

    const error = await generateStructured(model, schema, 'p', { timeoutMs: 5000 }).catch((err: unknown) => err) as Error;

    expect(error.message).toContain('finishReason: stop');
    expect(error.message).toContain('schema issues: summary:');
    expect(error.message).toContain('raw output: {"summary":42}');
  });

  it('flags a schema failure caused by hitting the maxTokens cap', async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'text-delta', id: '1', delta: '{"summary": "this json gets cut off mid-str' },
      { type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage: fakeUsage },
    ];
    const model = fakeStreamModel({ parts, close: true });

    const error = await generateStructured(model, schema, 'p', { timeoutMs: 5000 }).catch((err: unknown) => err) as Error;

    expect(error.message).toContain('finishReason: length');
    expect(error.message).toContain('truncated at the maxTokens cap');
    expect(error.message).toContain('raw output:');
  });
});
