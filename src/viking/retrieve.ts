/**
 * Read-only team-context retrieval from the shared OpenViking memory.
 *
 * One semantic search per review job, abstracts only, injected into the review
 * prompt as a provenance-carrying "Team context" section. The contract is
 * never-throw: any problem degrades to a non-`ok` status and the review
 * proceeds exactly as without the feature (fail-open).
 */

import type { WorkerConfig } from '../domain/config.js';
import { vikingSearch, type VikingHit } from './client.js';

export const MAX_TEAM_CONTEXT_HITS = 5;
export const MIN_TEAM_CONTEXT_SCORE = 0.45;
export const MAX_TEAM_CONTEXT_CHARS = 4000;
export const MAX_QUERY_PATHS = 15;
export const MAX_TEAM_CONTEXT_ABSTRACT_CHARS = 600;

const MAX_QUERY_BODY_CHARS = 400;
const DEFAULT_TARGET_URI = 'viking://resources/EPFL-ENAC';

export type TeamContextStatus = 'ok' | 'empty' | 'unavailable' | 'disabled';

export interface TeamContextResult {
  status: TeamContextStatus;
  /** Formatted bullet list for the review prompt; present only when status is 'ok'. */
  section?: string;
  /** Hits that made it into the section (the audit record of what shaped the review). */
  hits: VikingHit[];
  query?: string;
  error?: string;
}

export function buildTeamContextQuery(title: string, body: string, changedPaths: string[]): string {
  const parts = [title.trim()];
  const excerpt = body.trim().slice(0, MAX_QUERY_BODY_CHARS);
  if (excerpt) parts.push(excerpt);
  parts.push(...changedPaths.slice(0, MAX_QUERY_PATHS));
  return parts.filter((part) => part.length > 0).join('\n');
}

function compactAbstract(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TEAM_CONTEXT_ABSTRACT_CHARS
    ? `${oneLine.slice(0, MAX_TEAM_CONTEXT_ABSTRACT_CHARS)}… (truncated)`
    : oneLine;
}

/** Greedily renders hits as bullets until the section budget is exhausted (the first hit always fits). */
export function selectWithinBudget(hits: VikingHit[]): { kept: VikingHit[]; section: string } {
  const kept: VikingHit[] = [];
  const lines: string[] = [];
  let chars = 0;
  for (const hit of hits) {
    const line = `- ${compactAbstract(hit.abstract)} (${hit.uri})`;
    if (kept.length > 0 && chars + line.length + 1 > MAX_TEAM_CONTEXT_CHARS) break;
    kept.push(hit);
    lines.push(line);
    chars += line.length + 1;
  }
  return { kept, section: lines.join('\n') };
}

/**
 * Retrieves team context for a review job. Resolves with a status instead of
 * throwing: 'disabled' (feature off or repo not allowlisted — no call, no
 * trace), 'empty', 'unavailable', or 'ok' with a formatted section.
 */
export async function retrieveTeamContext(input: {
  config: WorkerConfig;
  repositoryFullName: string;
  title: string;
  body: string;
  changedPaths: string[];
}): Promise<TeamContextResult> {
  const { config } = input;
  if (!config.VIKING_BASE_URL || !config.VIKING_API_KEY) {
    return { status: 'disabled', hits: [] };
  }
  if (
    config.vikingReviewRepositories.length > 0 &&
    !config.vikingReviewRepositories.includes(input.repositoryFullName)
  ) {
    return { status: 'disabled', hits: [] };
  }

  const query = buildTeamContextQuery(input.title, input.body, input.changedPaths);
  try {
    const hits = (
      await vikingSearch(
        {
          baseUrl: config.VIKING_BASE_URL,
          apiKey: config.VIKING_API_KEY,
          timeoutMs: config.VIKING_TIMEOUT_MS,
        },
        {
          query,
          targetUri: config.VIKING_TARGET_URI ?? DEFAULT_TARGET_URI,
          limit: MAX_TEAM_CONTEXT_HITS,
          minScore: MIN_TEAM_CONTEXT_SCORE,
        },
      )
    )
      .filter((hit) => hit.score >= MIN_TEAM_CONTEXT_SCORE)
      .slice(0, MAX_TEAM_CONTEXT_HITS);

    if (hits.length === 0) return { status: 'empty', hits: [], query };

    const { kept, section } = selectWithinBudget(hits);
    if (kept.length === 0) return { status: 'empty', hits: [], query };

    return { status: 'ok', section, hits: kept, query };
  } catch (error) {
    return {
      status: 'unavailable',
      hits: [],
      query,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
