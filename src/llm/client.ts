import { streamObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { z } from 'zod';

type Provider = ReturnType<typeof createOpenAICompatible>;
export type LlmModel = ReturnType<Provider>;

export function createLlmModel(baseURL: string, apiKey: string, model: string): LlmModel {
  const provider = createOpenAICompatible({ name: 'internal-llm', baseURL, apiKey });
  return provider(model);
}

/**
 * Per-call guardrails for structured LLM generation. All values are optional
 * and fall back to conservative defaults: the hosted models are
 * thinking-by-default (their reasoning tokens count toward `max_tokens` and
 * toward wall-clock latency), so the cap must stay generous, and streaming is
 * used so long generations no longer trip idle-connection timeouts.
 */
export interface LlmCallOptions {
  /** Max completion tokens (reasoning + JSON output) per LLM call. */
  maxTokens?: number;
  /** Wall-clock budget per LLM call; the call aborts past it. */
  timeoutMs?: number;
  /** In-call retries by the AI SDK (job-level retries happen on top). */
  maxRetries?: number;
}

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 1;

export function llmCallSettings(options?: LlmCallOptions): {
  maxTokens: number;
  abortSignal: AbortSignal;
  maxRetries: number;
} {
  return {
    maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * Runs one schema-constrained generation as a stream. Streaming keeps bytes
 * flowing while the model generates, so long thinking phases no longer hit
 * the ~5 min idle timeout Node's fetch stack applies to non-streaming
 * responses (the previous source of timed-out jobs).
 */
export async function generateStructured<SchemaT extends z.ZodTypeAny>(
  model: LlmModel,
  schema: SchemaT,
  prompt: string,
  options?: LlmCallOptions,
): Promise<{ object: z.infer<SchemaT>; usage: { promptTokens: number; completionTokens: number } }> {
  const result = streamObject({
    model,
    schema,
    prompt,
    ...llmCallSettings(options),
    // Ask the (vLLM-backed) endpoint to emit token usage in the final stream
    // chunk; without this, streamed responses report NaN usage.
    providerOptions: { 'internal-llm': { stream_options: { include_usage: true } } },
  });
  // streamObject feeds its promises from a pull-based internal stream: it must
  // be actively consumed or `object`/`usage` never resolve.
  const stream = result.fullStream[Symbol.asyncIterator]();
  while (!(await stream.next()).done) {
    // drain; the validated final object is exposed via result.object
  }
  return { object: await result.object, usage: await result.usage };
}
