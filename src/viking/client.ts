/**
 * Thin HTTP client for the OpenViking retrieval API (read-only).
 *
 * Verified against the deployed server: `POST {base}/api/v1/search/find` with a
 * JSON body `{ query, target_uri, limit, score_threshold }` and a bearer token
 * returns `{ status, result: { memories, resources, skills, total } }` where the
 * items we care about carry `uri`, `abstract` and `score`. The client maps only
 * those three fields, so a response-shape drift surfaces as a thrown error
 * (surfaced as `unavailable` by the caller) instead of garbage injection.
 */

export interface VikingSearchConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface VikingSearchRequest {
  query: string;
  targetUri: string;
  limit: number;
  minScore: number;
}

export interface VikingHit {
  uri: string;
  abstract: string;
  score: number;
}

const SEARCH_PATH = '/api/v1/search/find';
const DEFAULT_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Maps the response body to hits, dropping malformed items; throws on shape drift. */
export function parseSearchResponse(payload: unknown): VikingHit[] {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new Error('OpenViking search response is missing its "result" object');
  }
  if (payload.result.resources === undefined) return [];
  if (!Array.isArray(payload.result.resources)) {
    throw new Error('OpenViking search response has a non-array "result.resources"');
  }
  const hits: VikingHit[] = [];
  for (const item of payload.result.resources) {
    if (!isRecord(item)) continue;
    const { uri, abstract, score } = item;
    if (typeof uri !== 'string' || uri === '' || typeof score !== 'number') continue;
    hits.push({ uri, abstract: typeof abstract === 'string' ? abstract : '', score });
  }
  return hits;
}

export async function vikingSearch(
  config: VikingSearchConfig,
  request: VikingSearchRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<VikingHit[]> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}${SEARCH_PATH}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      query: request.query,
      target_uri: request.targetUri,
      limit: request.limit,
      score_threshold: request.minScore,
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OpenViking search failed with HTTP ${response.status}`);
  }
  return parseSearchResponse(await response.json());
}
