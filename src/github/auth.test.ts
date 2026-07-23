import { describe, expect, it } from 'vitest';
import { normalizePrivateKey } from './auth.js';

describe('normalizePrivateKey', () => {
  it('returns a multi-line key unchanged', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nABCD\n-----END RSA PRIVATE KEY-----';
    expect(normalizePrivateKey(key)).toBe(key);
  });

  it('re-wraps a single-line PEM key into 64-character lines', () => {
    const body = 'A'.repeat(128);
    const key = `-----BEGIN RSA PRIVATE KEY-----${body}-----END RSA PRIVATE KEY-----`;
    const expected = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(64)}\n${'A'.repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    expect(normalizePrivateKey(key)).toBe(expected);
  });

  it('trims surrounding whitespace', () => {
    const key = '  -----BEGIN RSA PRIVATE KEY-----AB-----END RSA PRIVATE KEY-----  ';
    expect(normalizePrivateKey(key)).toBe('-----BEGIN RSA PRIVATE KEY-----\nAB\n-----END RSA PRIVATE KEY-----');
  });

  it('returns non-PEM strings unchanged', () => {
    expect(normalizePrivateKey('not a key')).toBe('not a key');
  });
});
