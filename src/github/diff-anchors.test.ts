import { describe, expect, it } from 'vitest';
import { isValidAnchor, parseDiffAnchors } from './diff-anchors.js';

const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,4 +10,5 @@ function foo() {
 context line 10
-removed line 11
+added line 11
+added line 12
 context line 13 (was 12)
`;

describe('parseDiffAnchors', () => {
  it('anchors added lines on the RIGHT side at their new line number', () => {
    const anchors = parseDiffAnchors(SIMPLE_DIFF);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 11, side: 'RIGHT' })).toBe(true);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 12, side: 'RIGHT' })).toBe(true);
  });

  it('anchors removed lines on the LEFT side at their old line number', () => {
    const anchors = parseDiffAnchors(SIMPLE_DIFF);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 11, side: 'LEFT' })).toBe(true);
  });

  it('anchors context lines on both sides', () => {
    const anchors = parseDiffAnchors(SIMPLE_DIFF);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 10, side: 'RIGHT' })).toBe(true);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 10, side: 'LEFT' })).toBe(true);
  });

  it('rejects a line/path/side combination that never appeared in the diff', () => {
    const anchors = parseDiffAnchors(SIMPLE_DIFF);
    expect(isValidAnchor(anchors, { path: 'src/foo.ts', line: 999, side: 'RIGHT' })).toBe(false);
    expect(isValidAnchor(anchors, { path: 'src/other.ts', line: 11, side: 'RIGHT' })).toBe(false);
  });

  it('tracks independent line counters across multiple files', () => {
    const twoFileDiff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 ctx
-old a
+new a
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -5,2 +5,2 @@
 ctx
-old b
+new b
`;
    const anchors = parseDiffAnchors(twoFileDiff);
    expect(isValidAnchor(anchors, { path: 'a.ts', line: 2, side: 'RIGHT' })).toBe(true);
    expect(isValidAnchor(anchors, { path: 'b.ts', line: 6, side: 'RIGHT' })).toBe(true);
  });
});
