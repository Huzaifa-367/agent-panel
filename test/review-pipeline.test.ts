import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChangeTracker } from '../src/changes';
import { buildReviewSpots, parseUnifiedDiff } from '../src/diff_hunks';

describe('review pipeline', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-panel-review-'));
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('builds navigable spots from a tracked turn', async () => {
    const tracker = new ChangeTracker(root);
    const base = await tracker.snapshotTree();
    writeFileSync(join(root, 'a.txt'), 'one\ntwo-edited\nthree\nfour\n');
    writeFileSync(join(root, 'b.txt'), 'new file\n');
    await tracker.captureTurn(base);
    const pending = tracker.getPending();
    assert.ok(pending.some((p) => p.relPath === 'a.txt'));
    assert.ok(pending.some((p) => p.relPath === 'b.txt'));

    const parsed = [];
    for (const f of pending) {
      const patch = await tracker.patchFor(f.relPath);
      const hunks = parseUnifiedDiff(patch);
      assert.ok(hunks.length >= 1 || f.status === 'added', `hunks for ${f.relPath}`);
      parsed.push({ relPath: f.relPath, hunks: hunks.length ? hunks : [{ line: 0, endLine: 0, added: [], deletedBefore: [], oldStart: 0, newStart: 1 }] });
    }
    const spots = buildReviewSpots(parsed);
    assert.ok(spots.length >= 2);
    assert.equal(new Set(spots.map((s) => s.relPath)).size, pending.length);

    await tracker.reject('b.txt');
    tracker.accept('a.txt');
    assert.equal(tracker.getPending().length, 0);
  });
});
