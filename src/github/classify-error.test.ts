import { describe, expect, it } from 'vitest';
import { isPermanentGithubError } from './classify-error.js';

describe('isPermanentGithubError', () => {
  it.each([401, 403, 404, 422])('treats %i as permanent', (status) => {
    expect(isPermanentGithubError({ status })).toBe(true);
  });

  it.each([500, 502, 503, 429])('treats %i as transient', (status) => {
    expect(isPermanentGithubError({ status })).toBe(false);
  });

  it('treats errors without a status as transient', () => {
    expect(isPermanentGithubError(new Error('network blip'))).toBe(false);
  });
});
