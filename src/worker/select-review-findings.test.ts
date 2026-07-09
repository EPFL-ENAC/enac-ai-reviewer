import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../llm/review.js';
import { selectReviewFindings } from './select-review-findings.js';

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return { path: 'src/foo.ts', line: 1, side: 'RIGHT', confidence: 'high', body: 'looks off', ...overrides };
}

describe('selectReviewFindings', () => {
  const validAnchors = new Set(Array.from({ length: 20 }, (_, i) => `src/foo.ts:${i + 1}:RIGHT`));

  it('drops low-confidence findings', () => {
    const result = selectReviewFindings([finding({ confidence: 'low' })], validAnchors, new Set());
    expect(result).toHaveLength(0);
  });

  it('drops findings that do not land on a real diff anchor', () => {
    const result = selectReviewFindings([finding({ line: 999 })], validAnchors, new Set());
    expect(result).toHaveLength(0);
  });

  it('drops a finding that duplicates an existing comment', () => {
    const existing = new Set(['src/foo.ts:1:RIGHT']);
    const result = selectReviewFindings([finding({ line: 1 })], validAnchors, existing);
    expect(result).toHaveLength(0);
  });

  it('dedupes the model proposing the same anchor twice', () => {
    const result = selectReviewFindings([finding({ line: 1 }), finding({ line: 1 })], validAnchors, new Set());
    expect(result).toHaveLength(1);
  });

  it('caps at 8 inline comments', () => {
    const many = Array.from({ length: 15 }, (_, i) => finding({ line: i + 1 }));
    const result = selectReviewFindings(many, validAnchors, new Set());
    expect(result).toHaveLength(8);
  });

  it('keeps medium and high confidence findings that pass all other checks', () => {
    const result = selectReviewFindings(
      [finding({ line: 1, confidence: 'medium' }), finding({ line: 2, confidence: 'high' })],
      validAnchors,
      new Set(),
    );
    expect(result).toHaveLength(2);
  });
});
