/** Parsed locations in the working (new) file for review navigation. */

export interface HunkLocation {
  /** 0-based start line in the working file (reveal / selection). */
  line: number;
  /** 0-based inclusive end line of added/context block in the working file. */
  endLine: number;
  /** Whole-line ranges to tint as insertions (0-based). */
  added: { start: number; end: number }[];
  /** 0-based lines in the working file immediately after a deletion. */
  deletedBefore: number[];
  oldStart: number;
  newStart: number;
  /** Original lines this change replaced or removed (from the live diff). */
  removed?: string[];
}

/**
 * Parse a unified diff into navigation hunks for the new (right/working) side.
 * Line numbers in the result are 0-based.
 */
export function parseUnifiedDiff(patch: string): HunkLocation[] {
  const hunks: HunkLocation[] = [];
  if (!patch.trim()) {
    return hunks;
  }
  let oldLine = 0;
  let newLine = 0;
  let cur: {
    oldStart: number;
    newStart: number;
    added: { start: number; end: number }[];
    deletedBefore: number[];
    firstNew: number | null;
    lastNew: number | null;
  } | null = null;

  const flush = () => {
    if (!cur) return;
    const line = cur.firstNew ?? Math.max(0, cur.newStart - 1);
    const endLine = cur.lastNew ?? line;
    hunks.push({
      line,
      endLine,
      added: cur.added,
      deletedBefore: cur.deletedBefore,
      oldStart: cur.oldStart,
      newStart: cur.newStart,
    });
    cur = null;
  };

  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@')) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!m) continue;
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      cur = {
        oldStart: Number(m[1]),
        newStart: Number(m[2]),
        added: [],
        deletedBefore: [],
        firstNew: null,
        lastNew: null,
      };
      continue;
    }
    if (!cur) continue;
    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('---') ||
      raw.startsWith('+++')
    ) {
      continue;
    }
    if (raw.startsWith('+')) {
      const zero = Math.max(0, newLine - 1);
      const last = cur.added[cur.added.length - 1];
      if (last && last.end === zero - 1) {
        last.end = zero;
      } else {
        cur.added.push({ start: zero, end: zero });
      }
      if (cur.firstNew === null) cur.firstNew = zero;
      cur.lastNew = zero;
      newLine += 1;
    } else if (raw.startsWith('-')) {
      const at = Math.max(0, newLine - 1);
      cur.deletedBefore.push(at);
      if (cur.firstNew === null) cur.firstNew = at;
      oldLine += 1;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    } else {
      // context (leading space) or bare
      const zero = Math.max(0, newLine - 1);
      if (cur.firstNew === null) cur.firstNew = zero;
      cur.lastNew = zero;
      oldLine += 1;
      newLine += 1;
    }
  }
  flush();
  return hunks;
}

/** Flatten file + hunk into a single walk order for next/prev change. */
export interface ReviewSpot {
  relPath: string;
  hunkIndex: number;
  line: number;
  endLine: number;
}

export function buildReviewSpots(
  files: { relPath: string; hunks: HunkLocation[] }[],
): ReviewSpot[] {
  const spots: ReviewSpot[] = [];
  for (const f of files) {
    if (!f.hunks.length) {
      spots.push({ relPath: f.relPath, hunkIndex: 0, line: 0, endLine: 0 });
      continue;
    }
    f.hunks.forEach((h, hunkIndex) => {
      spots.push({
        relPath: f.relPath,
        hunkIndex,
        line: h.line,
        endLine: h.endLine,
      });
    });
  }
  return spots;
}
