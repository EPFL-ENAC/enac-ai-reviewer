import { describe, expect, it } from 'vitest';
import type { InstallationOctokit } from './auth.js';
import { fetchFileContents, filterDiff, sanitizeRequestedPaths } from './fetch-context.js';

function section(path: string, body = 'hunk content'): string {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-${body}\n+${body} changed\n`;
}

describe('filterDiff', () => {
  it('keeps ordinary source file sections', () => {
    const diff = section('src/index.ts');
    expect(filterDiff(diff)).toContain('src/index.ts');
  });

  it('drops lock file sections', () => {
    const diff = section('src/index.ts') + section('pnpm-lock.yaml');
    const result = filterDiff(diff);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('pnpm-lock.yaml');
  });

  it('drops generated/dist file sections', () => {
    const diff = section('src/index.ts') + section('dist/bundle.min.js');
    const result = filterDiff(diff);
    expect(result).toContain('src/index.ts');
    expect(result).not.toContain('bundle.min.js');
  });

  it('drops every lock file pattern', () => {
    const paths = ['package-lock.json', 'yarn.lock', 'Gemfile.lock', 'composer.lock', 'Cargo.lock', 'poetry.lock'];
    for (const path of paths) {
      const result = filterDiff(section('src/index.ts') + section(path));
      expect(result, `expected ${path} to be dropped`).not.toContain(path);
    }
  });
});

describe('sanitizeRequestedPaths', () => {
  it('keeps ordinary relative paths', () => {
    expect(sanitizeRequestedPaths(['src/index.ts', 'README.md'])).toEqual(['src/index.ts', 'README.md']);
  });

  it('strips a leading ./ and deduplicates', () => {
    expect(sanitizeRequestedPaths(['./src/a.ts', 'src/a.ts', 'src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('drops empty, absolute, backslashed and traversal paths', () => {
    expect(sanitizeRequestedPaths(['', '   ', '/etc/passwd', 'src\\win.ts', '../secrets', 'src/../../etc'])).toEqual(
      [],
    );
  });
});

describe('fetchFileContents', () => {
  const target = { owner: 'EPFL-ENAC', repo: 'co2-calculator', ref: 'abc123' };
  const encode = (text: string | Uint8Array): string => Buffer.from(text).toString('base64');

  function octokitStub(handler: (path: string) => Promise<unknown>): InstallationOctokit {
    return {
      request: async (_route: string, params: { path: string }) => ({ data: await handler(params.path) }),
    } as unknown as InstallationOctokit;
  }

  it('fetches and decodes a file at the requested ref', async () => {
    const seenParams: { path: string; ref?: string }[] = [];
    const octokit: InstallationOctokit = {
      request: async (_route: string, params: { path: string; ref?: string }) => {
        seenParams.push(params);
        return { data: { type: 'file', size: 5, content: encode('hello') } };
      },
    } as unknown as InstallationOctokit;

    const result = await fetchFileContents(octokit, target, ['src/index.ts']);

    expect(result.get('src/index.ts')).toEqual({ status: 'fetched', content: 'hello' });
    expect(seenParams[0]).toMatchObject({ path: 'src/index.ts', ref: 'abc123' });
  });

  it('reports missing files instead of failing', async () => {
    const octokit = octokitStub(async () => {
      throw { status: 404 };
    });
    const result = await fetchFileContents(octokit, target, ['gone.ts']);
    expect(result.get('gone.ts')).toEqual({ status: 'not_found' });
  });

  it('reports directory listings and non-file entries as not found', async () => {
    const octokit = octokitStub(async (path) => (path === 'dir' ? [] : { type: 'symlink' }));
    const result = await fetchFileContents(octokit, target, ['dir', 'link']);
    expect(result.get('dir')).toEqual({ status: 'not_found' });
    expect(result.get('link')).toEqual({ status: 'not_found' });
  });

  it('skips binary payloads', async () => {
    const octokit = octokitStub(async () => ({ type: 'file', size: 2, content: encode(new Uint8Array([0x00, 0x01])) }));
    const result = await fetchFileContents(octokit, target, ['img.png']);
    expect(result.get('img.png')).toEqual({ status: 'binary_skipped' });
  });

  it('reports files above the per-file budget as too large', async () => {
    const big = 'a'.repeat(9000);
    const octokit = octokitStub(async () => ({ type: 'file', size: big.length, content: encode(big) }));
    const result = await fetchFileContents(octokit, target, ['big.ts']);
    expect(result.get('big.ts')).toEqual({ status: 'too_large' });
  });

  it('reports files with no content as too large when they have bytes, as not found otherwise', async () => {
    const octokit = octokitStub(async (path) =>
      path === 'huge.bin' ? { type: 'file', size: 2_000_000, content: null } : { type: 'file', size: 0, content: null },
    );
    const result = await fetchFileContents(octokit, target, ['huge.bin', 'empty.ts']);
    expect(result.get('huge.bin')).toEqual({ status: 'too_large' });
    expect(result.get('empty.ts')).toEqual({ status: 'not_found' });
  });

  it('skips lock files and generated files', async () => {
    const octokit = octokitStub(async () => {
      throw new Error('should not be requested');
    });
    const result = await fetchFileContents(octokit, target, ['package-lock.json', 'dist/bundle.js']);
    expect(result.get('package-lock.json')).toEqual({ status: 'skipped_generated' });
    expect(result.get('dist/bundle.js')).toEqual({ status: 'skipped_generated' });
  });

  it('exhausts the cumulative budget across files', async () => {
    const full = 'a'.repeat(8000);
    const octokit = octokitStub(async () => ({ type: 'file', size: full.length, content: encode(full) }));
    const result = await fetchFileContents(octokit, target, ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(result.get('a.ts')).toMatchObject({ status: 'fetched' });
    expect(result.get('b.ts')).toMatchObject({ status: 'fetched' });
    expect(result.get('c.ts')).toMatchObject({ status: 'fetched' });
    expect(result.get('d.ts')).toEqual({ status: 'budget_exhausted' });
  });

  it('rethrows non-404 errors', async () => {
    const octokit = octokitStub(async () => {
      throw { status: 500 };
    });
    await expect(fetchFileContents(octokit, target, ['boom.ts'])).rejects.toMatchObject({ status: 500 });
  });
});
