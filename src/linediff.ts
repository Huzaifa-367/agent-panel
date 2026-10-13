/**
 * Line diff between the original text and the live editor text, so in-editor highlights
 * stay exact while the file is edited or unsaved. Myers' O(ND) algorithm after trimming
 * the common start and end; very different files fall back to one replaced block.
 */

export interface LineChange {
  /** First line of the change in the new text (0-based). */
  newStart: number;
  /** Number of new lines (0 for a pure deletion). */
  newCount: number;
  /** The lines this change replaced or removed, from the original text. */
  removed: string[];
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline doesn't make an extra line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string, maxEdits = 4000): LineChange[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];
  const ops = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!ops) return [{ newStart: start, newCount: endB - start, removed: a.slice(start, endA) }];

  // Walk the edit script into blocks of consecutive changes.
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  let cur: LineChange | null = null;
  const close = () => {
    if (cur) changes.push(cur);
    cur = null;
  };
  for (const op of ops) {
    if (op === '=') {
      close();
      i += 1;
      j += 1;
    } else if (op === '-') {
      cur ??= { newStart: start + j, newCount: 0, removed: [] };
      cur.removed.push(a[start + i]);
      i += 1;
    } else {
      cur ??= { newStart: start + j, newCount: 0, removed: [] };
      cur.newCount += 1;
      j += 1;
    }
  }
  close();
  return changes;
}

/** Myers' shortest edit script: '=' keep, '-' delete from a, '+' insert from b. Null past the edit cap. */
function myers(a: string[], b: string[], maxEdits: number): ('=' | '-' | '+')[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, n, m, offset);
      }
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, offset: number): ('=' | '-' | '+')[] {
  const ops: ('=' | '-' | '+')[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x -= 1;
      y -= 1;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push('+');
      y -= 1;
    } else {
      ops.push('-');
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

/** "− first removed line (+N more)": the first line with text stands for the block. */
export function removedSummary(lines: string[]): string {
  const first = lines.find((l) => l.trim()) ?? '';
  const more = lines.length - 1;
  const head = first.trim() ? clip(first.trim()) : 'blank line';
  return `− ${head}${more > 0 ? `  (+${more} more line${more === 1 ? '' : 's'})` : ''}`;
}

export function clip(text: string, max = 90): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The span of `now` that differs from `old`, after the shared start and end. */
export function changedSpan(old: string, now: string): { start: number; end: number } | undefined {
  if (old === now) return undefined;
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start++;
  let endO = old.length;
  let endN = now.length;
  while (endO > start && endN > start && old[endO - 1] === now[endN - 1]) {
    endO--;
    endN--;
  }
  // Snap to word edges so the highlight reads as whole words.
  while (start > 0 && /\w/.test(now[start - 1])) start--;
  while (endN < now.length && /\w/.test(now[endN])) endN++;
  return { start, end: endN };
}
