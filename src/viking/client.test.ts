import { describe, expect, it, vi } from 'vitest';
import { parseSearchResponse, vikingSearch } from './client.js';

const config = { baseUrl: 'https://viking.example.org/', apiKey: 'test-key', timeoutMs: 1000 };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('parseSearchResponse', () => {
  it('maps resources to uri/abstract/score hits', () => {
    const hits = parseSearchResponse({
      status: 'ok',
      result: {
        resources: [
          { uri: 'viking://resources/x', abstract: 'note', score: 0.81, context_type: 'resources', level: 1 },
          { uri: 'viking://resources/y', abstract: '', score: 0.5 },
        ],
      },
    });
    expect(hits).toEqual([
      { uri: 'viking://resources/x', abstract: 'note', score: 0.81 },
      { uri: 'viking://resources/y', abstract: '', score: 0.5 },
    ]);
  });

  it('returns an empty list when result.resources is absent', () => {
    expect(parseSearchResponse({ status: 'ok', result: {} })).toEqual([]);
  });

  it('drops malformed items instead of failing the batch', () => {
    const hits = parseSearchResponse({
      result: {
        resources: [
          'not-an-object',
          { abstract: 'no uri' },
          { uri: 'viking://resources/x', score: 'not-a-number' },
          { uri: 'viking://resources/ok', score: 0.7 },
        ],
      },
    });
    expect(hits).toEqual([{ uri: 'viking://resources/ok', abstract: '', score: 0.7 }]);
  });

  it('throws on a missing result object', () => {
    expect(() => parseSearchResponse({ status: 'ok' })).toThrow(/missing its "result" object/);
    expect(() => parseSearchResponse('unexpected')).toThrow(/missing its "result" object/);
  });

  it('throws on a non-array resources field', () => {
    expect(() => parseSearchResponse({ result: { resources: 'oops' } })).toThrow(/non-array/);
  });
});

describe('vikingSearch', () => {
  it('posts to /api/v1/search/find with the bearer token, normalized base URL and mapped body', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { result: { resources: [{ uri: 'u', abstract: 'a', score: 0.9 }] } }),
    ) as unknown as typeof fetch;

    const hits = await vikingSearch(
      config,
      { query: 'team conventions', targetUri: 'viking://resources/EPFL-ENAC', limit: 5, minScore: 0.45 },
      fetchImpl,
    );

    expect(hits).toEqual([{ uri: 'u', abstract: 'a', score: 0.9 }]);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://viking.example.org/api/v1/search/find');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'team conventions',
      target_uri: 'viking://resources/EPFL-ENAC',
      limit: 5,
      score_threshold: 0.45,
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { status: 'error' })) as unknown as typeof fetch;

    await expect(
      vikingSearch(config, { query: 'q', targetUri: 'viking://resources/x', limit: 5, minScore: 0.45 }, fetchImpl),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('propagates transport errors (network failure, aborted timeout)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    }) as unknown as typeof fetch;

    await expect(
      vikingSearch(config, { query: 'q', targetUri: 'viking://resources/x', limit: 5, minScore: 0.45 }, fetchImpl),
    ).rejects.toThrow(/aborted/);
  });
});
