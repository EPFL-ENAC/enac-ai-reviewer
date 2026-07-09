import type { ReviewFinding } from '../llm/review.js';

const MAX_INLINE_COMMENTS = 8;

function findingKey(f: Pick<ReviewFinding, 'path' | 'line' | 'side'>): string {
  return `${f.path}:${f.line}:${f.side}`;
}

/**
 * Applies the PRD §12 review rules: only comment on lines that actually
 * changed, drop low-confidence findings, never duplicate an existing
 * comment, and cap at 8 inline comments per run.
 */
export function selectReviewFindings(
  findings: ReviewFinding[],
  validAnchors: Set<string>,
  existingAnchors: Set<string>,
): ReviewFinding[] {
  const selected: ReviewFinding[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (finding.confidence === 'low') continue;

    const key = findingKey(finding);
    if (!validAnchors.has(key)) continue;
    if (existingAnchors.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    selected.push(finding);
    if (selected.length >= MAX_INLINE_COMMENTS) break;
  }

  return selected;
}
