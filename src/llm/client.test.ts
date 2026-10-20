import { describe, expect, it } from 'vitest';
import type { LanguageModelV1, LanguageModelV1StreamPart } from 'ai';
import { z } from 'zod';
import { generateStructured } from './client.js';

function fakeStreamModel(options: { parts: LanguageModelV1StreamPart[]; close: boolean }): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'fake',
    modelId: 'fake-model',
    defaultObjectGenerationMode: 'json',
    doGenerate: async () => {
      throw new Error('doGenerate not used by generateStructured');
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of options.parts) controller.enqueue(part);
          if (options.close) controller.close();
        },
      }),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  };
}

const schema = z.object({ summary: z.string() });
const jsonPart: LanguageModelV1StreamPart = { type: 'text-delta', textDelta: JSON.stringify({ summary: 's' }) };
const finishPart: LanguageModelV1StreamPart = {
  type: 'finish',
  finishReason: 'stop',
  usage: { promptTokens: 10, completionTokens: 5 },
};

describe('generateStructured stream safety', () => {
  it('resolves the validated object and usage on a well-formed stream', async () => {
    const parts: LanguageModelV1StreamPart[] = [
      { type: 'response-metadata', modelId: 'fake-model' },
      jsonPart,
      finishPart,
    ];
    const model = fakeStreamModel({ parts, close: true });

    const { object, usage } = await generateStructured(model, schema, 'p', { timeoutMs: 5000 });

    expect(object).toEqual({ summary: 's' });
    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
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
});
