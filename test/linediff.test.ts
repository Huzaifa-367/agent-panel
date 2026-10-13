import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { changedSpan, diffLines, removedSummary, splitLines } from '../src/linediff';

/** Apply the changes to the old lines; must give the new lines back. */
function apply(oldText: string, newText: string): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: string[] = [];
  let i = 0; // position in a
  let j = 0; // position in b
  for (const c of diffLines(oldText, newText)) {
    while (j < c.newStart) {
      out.push(a[i]);
      i += 1;
      j += 1;
    }
    assert.deepEqual(a.slice(i, i + c.removed.length), c.removed, 'removed lines come from the old text in order');
    i += c.removed.length;
    for (let k = 0; k < c.newCount; k += 1) out.push(b[j + k]);
    j += c.newCount;
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

describe('line diff', () => {
  it('finds a replaced line, an insert and a delete', () => {
    const changes = diffLines('a\nb\nc\nd\ne\n', 'a\nB\nc\nx\ne\nf\n');
    assert.deepEqual(changes, [
      { newStart: 1, newCount: 1, removed: ['b'] },
      { newStart: 3, newCount: 1, removed: ['d'] },
      { newStart: 5, newCount: 1, removed: [] },
    ]);
  });

  it('reports a pure deletion at the line after it', () => {
    assert.deepEqual(diffLines('a\nb\nc', 'a\nc'), [{ newStart: 1, newCount: 0, removed: ['b'] }]);
  });

  it('is empty for equal text and handles empty sides', () => {
    assert.deepEqual(diffLines('x\ny', 'x\ny'), []);
    assert.deepEqual(diffLines('', 'a\nb'), [{ newStart: 0, newCount: 2, removed: [''] }]);
  });

  it('reproduces the new text for 500 random edits', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 500; t += 1) {
      const a = Array.from({ length: rnd(30) + 1 }, () => `l${rnd(8)}`);
      const b = [...a];
      for (let e = rnd(6); e >= 0; e -= 1) {
        const op = rnd(3);
        const at = rnd(b.length + 1);
        if (op === 0 && b.length) b.splice(Math.min(at, b.length - 1), 1);
        else if (op === 1) b.splice(at, 0, `n${rnd(8)}`);
        else if (b.length) b[Math.min(at, b.length - 1)] = `m${rnd(8)}`;
      }
      const oldText = a.join('\n');
      const newText = b.join('\n');
      assert.deepEqual(apply(oldText, newText), splitLines(newText), `case ${t}`);
    }
  });
});

describe('inline change marks', () => {
  it('marks only the changed words of a line', () => {
    const now = '**Status:** built through Phase 6 (tenancy)';
    const span = changedSpan('**Status:** Phase 0b, the skeleton.', now)!;
    assert.equal(now.slice(span.start, span.end), 'built through Phase 6 (tenancy)');
    assert.equal(changedSpan('same', 'same'), undefined);
  });

  it('sums up removed lines by the first one with text', () => {
    assert.equal(removedSummary(['> `docs/README.md` still opens', '']), '− > `docs/README.md` still opens  (+1 more line)');
    assert.equal(removedSummary(['']), '− blank line');
  });
});
