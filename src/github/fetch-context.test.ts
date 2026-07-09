import { describe, expect, it } from 'vitest';
import { filterDiff } from './fetch-context.js';

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
