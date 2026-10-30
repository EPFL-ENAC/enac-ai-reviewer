export type LlmPromptEvent = { type: 'llm_prompt'; prompt: string };

export type LlmResponseEvent = {
  type: 'llm_response';
  result: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Model thinking (reasoning) text, truncated for the trace. Empty when the model emitted none. */
  reasoningText: string;
  /** Full length of the thinking text before truncation. */
  reasoningChars: number;
};

export type LlmEvent = LlmPromptEvent | LlmResponseEvent;

export type LlmEventListener = (event: LlmEvent) => Promise<void> | void;

/**
 * Max chars of model thinking kept per trace. Thinking runs 10k+ chars on
 * substantial prompts (it shares the output-token budget), so the trace keeps
 * head and tail only; `reasoningChars` records the true size.
 */
const REASONING_EXCERPT_CHARS = 2500;
const REASONING_TAIL_CHARS = 500;

export function excerptReasoning(reasoning: string): { reasoningText: string; reasoningChars: number } {
  if (reasoning.length <= REASONING_EXCERPT_CHARS) {
    return { reasoningText: reasoning, reasoningChars: reasoning.length };
  }
  const head = reasoning.slice(0, REASONING_EXCERPT_CHARS - REASONING_TAIL_CHARS);
  const tail = reasoning.slice(-REASONING_TAIL_CHARS);
  return { reasoningText: `${head}\n…\n${tail}`, reasoningChars: reasoning.length };
}
