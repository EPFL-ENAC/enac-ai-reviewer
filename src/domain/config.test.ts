import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/test',
  GITHUB_APP_ID: '1',
  GITHUB_PRIVATE_KEY: 'key',
  GITHUB_BOT_LOGIN: 'enac-ai-reviewer',
  LLM_BASE_URL: 'https://llm.example.org/v1',
  LLM_API_KEY: 'llm-key',
  LLM_MODEL: 'test-model',
};

describe('loadWorkerConfig', () => {
  it('parses without any VIKING_* vars (team-context feature disabled)', () => {
    const config = loadWorkerConfig(base);
    expect(config.VIKING_BASE_URL).toBeUndefined();
    expect(config.VIKING_API_KEY).toBeUndefined();
    expect(config.vikingReviewRepositories).toEqual([]);
  });

  it('rejects a base URL without an API key', () => {
    expect(() => loadWorkerConfig({ ...base, VIKING_BASE_URL: 'https://viking.example.org' })).toThrow(
      /VIKING_API_KEY is required/,
    );
  });

  it('accepts a fully configured OpenViking endpoint and splits the repo allowlist', () => {
    const config = loadWorkerConfig({
      ...base,
      VIKING_BASE_URL: 'https://viking.example.org',
      VIKING_API_KEY: 'viking-key',
      VIKING_TARGET_URI: 'viking://resources/EPFL-ENAC',
      VIKING_REVIEW_REPOSITORIES: 'EPFL-ENAC/a,EPFL-ENAC/b',
      VIKING_TIMEOUT_MS: '2500',
    });
    expect(config.VIKING_BASE_URL).toBe('https://viking.example.org');
    expect(config.VIKING_TARGET_URI).toBe('viking://resources/EPFL-ENAC');
    expect(config.vikingReviewRepositories).toEqual(['EPFL-ENAC/a', 'EPFL-ENAC/b']);
    expect(config.VIKING_TIMEOUT_MS).toBe(2500);
  });
});
