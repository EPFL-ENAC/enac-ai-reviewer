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
  const settings = llmCallSettings(options);
  const result = streamObject({
    model,
    schema,
    prompt,
    ...settings,
    // Ask the (vLLM-backed) endpoint to emit token usage in the final stream
    // chunk; without this, streamed responses report NaN usage.
    providerOptions: { 'internal-llm': { stream_options: { include_usage: true } } },
  });

  // streamObject feeds its promises from a pull-based internal stream: it must
  // be actively consumed or `object`/`usage` never resolve. Draining also lets
  // us detect streams that end without a `finish` event (gateway cutting a
  // long generation) — in that case result.object would hang forever.
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const drain = (async (): Promise<string | undefined> => {
    let sawFinish = false;
    let finishReason: string | undefined;
    for (;;) {
      const { done, value } = await iterator.next();
      if (done) break;
      if (value == null || typeof value !== 'object') continue;
      const part = value as { type?: unknown; error?: unknown; finishReason?: unknown };
      // Gateway/upstream failures arrive as error events inside the SSE
      // stream (LiteLLM style). Surface the real cause instead of masking it
      // as a missing completion event.
      if (part.type === 'error') {
        throw part.error instanceof Error
          ? part.error
          : new Error(`LLM stream error: ${JSON.stringify(part.error)?.slice(0, 500)}`);
      }
      if (part.type === 'finish') {
        sawFinish = true;
        const fr = (part as { finishReason?: unknown }).finishReason;
        if (typeof fr === 'string') {
          finishReason = fr;
        } else if (fr != null && typeof fr === 'object' && typeof (fr as { unified?: unknown }).unified === 'string') {
          finishReason = (fr as { unified: string }).unified;
        }
      }
    }
    return sawFinish ? finishReason : undefined;
  })();

  const aborted = new Promise<never>((_, reject) => {
    const signal = settings.abortSignal;
    if (signal.aborted) {
      reject(new Error(`LLM call aborted before completion (${String(signal.reason)})`));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new Error(`LLM call exceeded its time budget (${String(signal.reason)})`)),
      { once: true },
    );
  });
  aborted.catch(() => {}); // stays unhandled if the drain wins the race

  let finishReason: string | undefined;
  try {
    finishReason = await Promise.race([drain, aborted]);
    if (finishReason === undefined) {
      throw new Error('LLM stream ended without a completion event (connection closed early)');
    }
  } catch (err) {
    drain.catch(() => {}); // the losing drain may reject later; don't crash the worker
    await iterator.return?.();
    throw err;
  }

  let object: z.infer<SchemaT>;
  try {
    object = (await result.object) as z.infer<SchemaT>;
  } catch (err) {
    throw describeSchemaFailure(err, finishReason);
  }
  const usage = await result.usage;
  return {
    object,
    usage: {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
    },
  };
}

/**
 * Turns the AI SDK's opaque "No object generated" error into a message that
 * says WHY the output failed validation: the finish reason (a `length` finish
 * means the model ran out of tokens mid-JSON), the zod issues, and an excerpt
 * of the raw output. This is what ends up in the job's error_message.
 */
function describeSchemaFailure(err: unknown, streamFinishReason: string | undefined): Error {
  const source = err as {
    name?: string;
    message?: string;
    text?: unknown;
    finishReason?: unknown;
    cause?: unknown;
  };
  if (source?.name !== 'AI_NoObjectGeneratedError') {
    return err instanceof Error ? err : new Error(String(err));
  }

  const reason =
    typeof source.finishReason === 'string' && source.finishReason !== 'unknown'
      ? source.finishReason
      : streamFinishReason;
  const parts = [`LLM output failed schema validation (finishReason: ${reason ?? 'unknown'})`];

  const cause = source.cause as
    | { name?: string; message?: string; issues?: unknown; cause?: { issues?: unknown } }
    | undefined;
  const issues = (cause?.issues ?? cause?.cause?.issues) as
    | Array<{ path?: unknown; message?: unknown }>
    | undefined;
  if (Array.isArray(issues) && issues.length > 0) {
    const summary = issues
      .slice(0, 3)
      .map((issue) => {
        const { path, message } = issue as { path?: unknown; message?: unknown };
        return Array.isArray(path) && path.length > 0 ? `${path.join('.')}: ${String(message)}` : String(message);
      })
      .join('; ');
    parts.push(`schema issues: ${summary}`);
  } else if (cause) {
    parts.push(`cause: ${cause.name}: ${cause.message}`);
  }
  if (reason === 'length') {
    parts.push('output was truncated at the maxTokens cap before the JSON completed');
  }

  const raw = typeof source.text === 'string' ? source.text : '';
  if (raw) {
    const head = raw.slice(0, 400);
    const tail = raw.length > 600 ? ` … ${raw.slice(-200)}` : raw.slice(400);
    parts.push(`raw output: ${head}${tail}`);
  }

  return new Error(parts.join(' | ').replace(/\s+/g, ' ').slice(0, 1200));
}
