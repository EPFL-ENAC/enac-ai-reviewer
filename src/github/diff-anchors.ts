export interface DiffAnchor {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
}

function anchorKey(a: DiffAnchor): string {
  return `${a.path}:${a.line}:${a.side}`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff into the set of (path, line, side) anchors GitHub's
 * pulls review-comment API (`line`/`side`, not the deprecated `position`
 * index) will accept — i.e. every line that actually appears in a hunk.
 */
export function parseDiffAnchors(diff: string): Set<string> {
  const anchors = new Set<string>();
  const sections = diff.split(/(?=^diff --git )/m);

  for (const section of sections) {
    const path = /^diff --git a\/(.+?) b\//m.exec(section)?.[1];
    if (!path) continue;

    const lines = section.split('\n');
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;

    for (const line of lines) {
      const hunkMatch = HUNK_HEADER.exec(line);
      if (hunkMatch) {
        oldLine = Number(hunkMatch[1]);
        newLine = Number(hunkMatch[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        anchors.add(anchorKey({ path, line: newLine, side: 'RIGHT' }));
        newLine++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        anchors.add(anchorKey({ path, line: oldLine, side: 'LEFT' }));
        oldLine++;
      } else if (line.startsWith(' ')) {
        anchors.add(anchorKey({ path, line: newLine, side: 'RIGHT' }));
        anchors.add(anchorKey({ path, line: oldLine, side: 'LEFT' }));
        oldLine++;
        newLine++;
      }
      // other lines (e.g. "\ No newline at end of file") don't advance counters
    }
  }

  return anchors;
}

export function isValidAnchor(anchors: Set<string>, anchor: DiffAnchor): boolean {
  return anchors.has(anchorKey(anchor));
}
