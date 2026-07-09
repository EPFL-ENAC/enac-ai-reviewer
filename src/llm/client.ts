import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

type Provider = ReturnType<typeof createOpenAICompatible>;
export type LlmModel = ReturnType<Provider>;

export function createLlmModel(baseURL: string, apiKey: string, model: string): LlmModel {
  const provider = createOpenAICompatible({ name: 'internal-llm', baseURL, apiKey });
  return provider(model);
}
