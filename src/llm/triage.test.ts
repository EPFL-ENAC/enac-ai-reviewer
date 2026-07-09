import { describe, expect, it } from 'vitest';
import { formatTriageComment } from './triage.js';

describe('formatTriageComment', () => {
  it('renders the PRD §13 triage comment shape', () => {
    const comment = formatTriageComment({
      likelyType: 'bug',
      confidence: 'medium',
      missingInformation: ['Browser/version', 'Steps to reproduce'],
      suggestedLabels: ['bug', 'frontend'],
    });

    expect(comment).toContain('### AI triage');
    expect(comment).toContain('Likely type: bug');
    expect(comment).toContain('Confidence: medium');
    expect(comment).toContain('- Browser/version');
    expect(comment).toContain('- bug');
  });

  it('renders placeholders when there is nothing missing or to suggest', () => {
    const comment = formatTriageComment({
      likelyType: 'question',
      confidence: 'high',
      missingInformation: [],
      suggestedLabels: [],
    });

    expect(comment).toContain('(none — issue looks well-specified)');
    expect(comment).toContain('(none)');
  });
});
