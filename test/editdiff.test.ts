import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePatch, stepEdit } from '../src/editdiff';
import { splitLines } from '../src/linediff';

/** Apply a unified diff to old lines, checking every context and removed line. */
function apply(oldText: string, patch: string): string[] {
  const a = splitLines(oldText);
  const out: string[] = [];
  let i = 0;
  for (const line of patch.split('\n')) {
    const m = /^@@ -(\d+),(\d+) /.exec(line);
    if (m) {
      const start = Number(m[2]) === 0 ? Number(m[1]) : Number(m[1]) - 1;
      while (i < start) out.push(a[i++]);
      continue;
    }
    if (line.startsWith('+')) out.push(line.slice(1));
    else if (line.startsWith('-')) assert.equal(a[i++], line.slice(1));
    else if (line.startsWith(' ')) {
      assert.equal(a[i], line.slice(1));
      out.push(a[i++]);
    }
  }
  while (i < a.length) out.push(a[i++]);
  return out;
}

describe('edit diffs', () => {
  it('patches apply back to the new text, 400 random cases', () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 400; t += 1) {
      const a = Array.from({ length: rnd(40) + 1 }, () => `l${rnd(6)}`);
      const b = [...a];
      for (let e = rnd(5); e >= 0; e -= 1) {
        const at = rnd(b.length + 1);
        const op = rnd(3);
        if (op === 0 && b.length > 1) b.splice(Math.min(at, b.length - 1), 1);
        else if (op === 1) b.splice(at, 0, `n${rnd(6)}`);
        else if (b.length) b[Math.min(at, b.length - 1)] = `m${rnd(6)}`;
      }
      const { diff } = makePatch(a.join('\n'), b.join('\n'));
      assert.deepEqual(apply(a.join('\n'), diff ?? ''), b, `case ${t}`);
    }
  });

  it('builds a step diff from an Edit, before or after the CLI applies it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ap-edit-'));
    try {
      writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\nfour\n');
      const input = { file_path: join(root, 'a.ts'), old_string: 'two', new_string: 'TWO\nTWO-B' };
      const before = stepEdit(root, 'Edit', input)!;
      assert.equal(before.path, 'a.ts');
      assert.equal(before.additions, 2);
      assert.equal(before.deletions, 1);
      assert.equal(before.line, 1);
      writeFileSync(join(root, 'a.ts'), 'one\nTWO\nTWO-B\nthree\nfour\n');
      const after = stepEdit(root, 'Edit', input)!;
      assert.equal(after.diff, before.diff);
      assert.deepEqual(stepEdit(root, 'Read', { file_path: join(root, 'a.ts'), offset: 3 }), { path: 'a.ts', line: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
