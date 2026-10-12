export type LlmPromptEvent = { type: 'llm_prompt'; prompt: string };

export type LlmResponseEvent = {
  type: 'llm_response';
  result: unknown;
  inputTokens: number;
  outputTokens: number;
};

export type LlmEvent = LlmPromptEvent | LlmResponseEvent;

export type LlmEventListener = (event: LlmEvent) => Promise<void> | void;
