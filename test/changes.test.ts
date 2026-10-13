import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChangeTracker, safeAbs, blobAt } from '../src/changes';

describe('ChangeTracker', () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-panel-changes-'));
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'line1\nline2\n');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('tracks edit, new file, deleted file; reject restores each', async () => {
    const tracker = new ChangeTracker(root);
    const base = await tracker.snapshotTree();

    writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\n');
    writeFileSync(join(root, 'b.txt'), 'hello\n');
    rmSync(join(root, 'keep.txt'));

    await tracker.captureTurn(base);
    const pending = tracker.getPending();
    const by = Object.fromEntries(pending.map((p) => [p.relPath, p]));

    assert.ok(by['a.txt']);
    assert.equal(by['a.txt'].status, 'modified');
    assert.ok(by['a.txt'].additions >= 1);

    assert.ok(by['b.txt']);
    assert.equal(by['b.txt'].status, 'added');

    assert.ok(by['keep.txt']);
    assert.equal(by['keep.txt'].status, 'deleted');

    await tracker.reject('a.txt');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'line1\nline2\n');
    assert.ok(!tracker.getPending().some((p) => p.relPath === 'a.txt'));

    await tracker.reject('b.txt');
    assert.equal(existsSync(join(root, 'b.txt')), false);

    await tracker.reject('keep.txt');
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(tracker.getPending().length, 0);
  });

  it('undoes an accept and a reject', async () => {
    const tracker = new ChangeTracker(root);
    writeFileSync(join(root, 'a.txt'), 'line1\nline2\n');
    const base = await tracker.snapshotTree();
    writeFileSync(join(root, 'a.txt'), 'line1\nchanged\n');
    const turn = await tracker.captureTurn(base);
    assert.deepEqual(turn.turnFiles.map((f) => f.relPath), ['a.txt']);

    tracker.accept('a.txt');
    assert.equal(tracker.stateOf('a.txt'), 'accepted');
    await tracker.undo('a.txt');
    assert.equal(tracker.stateOf('a.txt'), 'pending');

    await tracker.reject('a.txt');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'line1\nline2\n');
    assert.equal(tracker.stateOf('a.txt'), 'rejected');
    await tracker.undo('a.txt');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'line1\nchanged\n');
    assert.equal(tracker.stateOf('a.txt'), 'pending');

    const patch = await tracker.patchBetween(turn.baseTree, turn.afterTree, 'a.txt');
    assert.match(patch, /\+changed/);
  });

  it('refuses paths that leave the workspace', () => {
    assert.throws(() => safeAbs(root, '../outside.txt'));
    assert.throws(() => safeAbs(root, '/etc/passwd'));
    assert.equal(safeAbs(root, 'sub/x.txt'), join(root, 'sub', 'x.txt'));
  });

  it('only reports a file as absent when git confirms it, never on a git failure', async () => {
    const tracker = new ChangeTracker(root);
    const tree = await tracker.snapshotTree();
    assert.equal(await blobAt(root, tree, 'no-such-file.txt'), null);
    assert.ok(await blobAt(root, tree, 'a.txt'));
    // A tree git does not know is an error, not "the file is missing".
    await assert.rejects(() => blobAt(root, '0'.repeat(40), 'a.txt'));
  });
});
