import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerConfig } from '../domain/config.js';

const vikingSearch = vi.fn();
vi.mock('./client.js', () => ({ vikingSearch: (...args: unknown[]) => vikingSearch(...args) }));

const { MAX_TEAM_CONTEXT_CHARS, MAX_TEAM_CONTEXT_HITS, retrieveTeamContext } = await import('./retrieve.js');

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    VIKING_BASE_URL: 'https://viking.example.org',
    VIKING_API_KEY: 'test-key',
    vikingReviewRepositories: [],
    ...overrides,
  } as unknown as WorkerConfig;
}

const baseInput = {
  repositoryFullName: 'EPFL-ENAC/demo',
  title: 'Add widget',
  body: 'Adds a widget',
  changedPaths: ['src/widget.ts'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('retrieveTeamContext', () => {
  it('is disabled and performs no search when VIKING_BASE_URL is unset', async () => {
    const result = await retrieveTeamContext({
      ...baseInput,
      config: config({ VIKING_BASE_URL: undefined, VIKING_API_KEY: undefined }),
    });

    expect(result.status).toBe('disabled');
    expect(vikingSearch).not.toHaveBeenCalled();
  });

  it('is disabled for repositories outside the allowlist', async () => {
    const result = await retrieveTeamContext({
      ...baseInput,
      config: config({ vikingReviewRepositories: ['EPFL-ENAC/other'] }),
    });

    expect(result.status).toBe('disabled');
    expect(vikingSearch).not.toHaveBeenCalled();
  });

  it('performs one search with the built query and formats hits as provenance bullets', async () => {
    vikingSearch.mockResolvedValue([
      { uri: 'viking://resources/EPFL-ENAC/adr-007', abstract: 'We use node-pg-migrate with plain SQL.', score: 0.81 },
    ]);

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('ok');
    expect(result.section).toBe('- We use node-pg-migrate with plain SQL. (viking://resources/EPFL-ENAC/adr-007)');
    expect(result.hits).toHaveLength(1);
    expect(vikingSearch).toHaveBeenCalledTimes(1);
    const request = vikingSearch.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.query).toContain('Add widget');
    expect(request.query).toContain('Adds a widget');
    expect(request.query).toContain('src/widget.ts');
    expect(request.targetUri).toBe('viking://resources/EPFL-ENAC');
    expect(request.limit).toBe(MAX_TEAM_CONTEXT_HITS);
    expect(request.minScore).toBe(0.45);
  });

  it('collapses multi-line abstracts to a single bullet line', async () => {
    vikingSearch.mockResolvedValue([
      { uri: 'viking://resources/x', abstract: '# Overview\n\nThis covers\nseveral lines.', score: 0.8 },
    ]);

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.section).toBe('- # Overview This covers several lines. (viking://resources/x)');
  });

  it('filters hits below the score floor and caps the hit count', async () => {
    const scores = [0.95, 0.9, 0.8, 0.7, 0.6, 0.44, 0.3];
    vikingSearch.mockResolvedValue(
      scores.map((score, index) => ({ uri: `viking://resources/hit-${index}`, abstract: `note ${index}`, score })),
    );

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('ok');
    expect(result.hits).toHaveLength(MAX_TEAM_CONTEXT_HITS);
    expect(result.section?.split('\n')).toHaveLength(MAX_TEAM_CONTEXT_HITS);
    expect(result.section).not.toContain('hit-5');
  });

  it('truncates long abstracts and stops within the section budget', async () => {
    vikingSearch.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        uri: `viking://resources/hit-${index}`,
        abstract: `note ${index} ${'x'.repeat(600)}`,
        score: 0.9,
      })),
    );

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('ok');
    expect(result.hits.length).toBeLessThan(10);
    expect(result.section!.length).toBeLessThanOrEqual(MAX_TEAM_CONTEXT_CHARS);
    expect(result.section).toContain('(truncated)');
  });

  it('is empty when the search returns no hits', async () => {
    vikingSearch.mockResolvedValue([]);

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('empty');
    expect(result.section).toBeUndefined();
  });

  it('is empty when every hit is below the score floor', async () => {
    vikingSearch.mockResolvedValue([{ uri: 'viking://resources/low', abstract: 'weak', score: 0.1 }]);

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('empty');
  });

  it('degrades to unavailable without throwing when retrieval fails', async () => {
    vikingSearch.mockRejectedValue(new Error('OpenViking search failed with HTTP 503'));

    const result = await retrieveTeamContext({ ...baseInput, config: config() });

    expect(result.status).toBe('unavailable');
    expect(result.error).toContain('HTTP 503');
    expect(result.section).toBeUndefined();
  });
});
