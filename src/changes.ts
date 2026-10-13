import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FileChange {
  path: string;
  relPath: string;
  additions: number;
  deletions: number;
  /** Git tree id from before the first turn that touched this file. */
  baseTree: string;
  status: 'modified' | 'added' | 'deleted';
}

export interface TurnDiff {
  baseTree: string;
  afterTree: string;
  /** Files this turn changed, with this turn's own counts. */
  turnFiles: FileChange[];
  /** Everything still pending after this turn. */
  files: FileChange[];
}

/** What happened to a file that is no longer pending, kept so it can be undone. */
export interface Resolution {
  state: 'accepted' | 'rejected';
  file: FileChange;
  /** Tree holding the agent's version, to put it back after a reject. */
  afterTree?: string;
}

export class ChangeTracker {
  private pending = new Map<string, FileChange>();
  private resolved = new Map<string, Resolution>();
  private lastAfterTree: string | undefined;
  /** The working tree as a git tree, reused for a moment so opening several diffs costs one snapshot. */
  private current?: { tree: Promise<string>; at: number };

  constructor(private readonly workspaceRoot: string) {}

  getPending(): FileChange[] {
    return [...this.pending.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  totals(): { files: number; additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const f of this.pending.values()) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { files: this.pending.size, additions, deletions };
  }

  async snapshotTree(): Promise<string> {
    await assertGitRepo(this.workspaceRoot);
    const dir = mkdtempSync(join(tmpdir(), 'agent-panel-idx-'));
    const indexPath = join(dir, 'index');
    const gitDir = join(this.workspaceRoot, '.git');
    const sourceIndex = join(gitDir, 'index');
    if (existsSync(sourceIndex)) {
      copyFileSync(sourceIndex, indexPath);
    }
    try {
      await git(this.workspaceRoot, ['add', '-A'], { GIT_INDEX_FILE: indexPath });
      const tree = (await git(this.workspaceRoot, ['write-tree'], { GIT_INDEX_FILE: indexPath })).trim();
      return tree;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Pending and resolved state, for the chat's file cards. */
  stateOf(relPath: string): 'pending' | 'accepted' | 'rejected' | undefined {
    if (this.pending.has(relPath)) return 'pending';
    return this.resolved.get(relPath)?.state;
  }

  /** Snapshot of the working tree, shared by calls within half a second. */
  private currentTree(): Promise<string> {
    if (this.current && Date.now() - this.current.at < 500) return this.current.tree;
    const tree = this.snapshotTree();
    this.current = { tree, at: Date.now() };
    tree.catch(() => (this.current = undefined));
    return tree;
  }

  /** Forget the cached snapshot after the panel itself changes files. */
  invalidate(): void {
    this.current = undefined;
  }

  async captureTurn(baseTree: string): Promise<TurnDiff> {
    const afterTree = await this.snapshotTree();
    this.current = { tree: Promise.resolve(afterTree), at: Date.now() };
    this.lastAfterTree = afterTree;
    const files = await diffTrees(this.workspaceRoot, baseTree, afterTree);
    for (const file of files) {
      this.resolved.delete(file.relPath);
      if (!this.pending.has(file.relPath)) this.pending.set(file.relPath, { ...file, baseTree });
    }
    // Refresh every pending file against its own base: one diff per distinct base, not per file.
    const byBase = new Map<string, string[]>();
    for (const f of this.pending.values()) byBase.set(f.baseTree, [...(byBase.get(f.baseTree) ?? []), f.relPath]);
    for (const [base, paths] of byBase) {
      const now = new Map((await diffTrees(this.workspaceRoot, base, afterTree, paths)).map((f) => [f.relPath, f]));
      for (const rel of paths) {
        const f = now.get(rel);
        // Back to its original content: nothing left to review.
        if (!f) this.pending.delete(rel);
        else this.pending.set(rel, { ...f, baseTree: base });
      }
    }
    return { baseTree, afterTree, turnFiles: files, files: this.getPending() };
  }

  /** Put files back to how they were in `tree`, deleting ones it doesn't have. Files only, chat untouched. */
  async restore(tree: string, paths: string[]): Promise<void> {
    for (const rel of paths) {
      const abs = join(this.workspaceRoot, rel);
      let content: Buffer | null = null;
      try {
        content = await gitBuffer(this.workspaceRoot, ['show', `${tree}:${rel}`]);
      } catch {
        content = null;
      }
      if (content === null) {
        if (existsSync(abs)) unlinkSync(abs);
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      this.pending.delete(rel);
      this.resolved.delete(rel);
    }
    this.invalidate();
  }

  /** The diff of one file between two trees, e.g. one turn's own change. */
  async patchBetween(baseTree: string, afterTree: string, relPath: string): Promise<string> {
    return git(this.workspaceRoot, ['diff', baseTree, afterTree, '--', relPath]);
  }

  async patchFor(relPath: string): Promise<string> {
    const file = this.pending.get(relPath);
    if (!file) {
      return '';
    }
    const after = await this.currentTree();
    return git(this.workspaceRoot, ['diff', file.baseTree, after, '--', relPath]);
  }

  async baseContent(relPath: string): Promise<string | null> {
    const file = this.pending.get(relPath);
    if (!file) {
      return null;
    }
    try {
      return await git(this.workspaceRoot, ['show', `${file.baseTree}:${relPath}`]);
    } catch {
      return null;
    }
  }

  accept(relPath: string): void {
    const file = this.pending.get(relPath);
    if (file) {
      this.resolved.set(relPath, { state: 'accepted', file });
    }
    this.pending.delete(relPath);
  }

  acceptAll(): void {
    for (const rel of [...this.pending.keys()]) {
      this.accept(rel);
    }
  }

  /**
   * Undo an Accept (the file is pending again) or a Reject (the agent's version is
   * written back, then pending again).
   */
  async undo(relPath: string): Promise<void> {
    const r = this.resolved.get(relPath);
    if (!r) {
      return;
    }
    if (r.state === 'rejected') {
      const abs = join(this.workspaceRoot, relPath);
      if (r.file.status === 'deleted') {
        if (existsSync(abs)) unlinkSync(abs);
      } else if (r.afterTree) {
        const content = await gitBuffer(this.workspaceRoot, ['show', `${r.afterTree}:${relPath}`]);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    this.resolved.delete(relPath);
    this.pending.set(relPath, r.file);
    this.invalidate();
  }

  async reject(relPath: string): Promise<void> {
    const file = this.pending.get(relPath);
    if (!file) {
      return;
    }
    // Keep the agent's version so Undo can restore it.
    let afterTree = this.lastAfterTree;
    try {
      afterTree = await this.currentTree();
    } catch {
      /* keep the last turn's tree */
    }
    this.resolved.set(relPath, { state: 'rejected', file, afterTree });
    const abs = join(this.workspaceRoot, relPath);
    if (file.status === 'added') {
      if (existsSync(abs)) {
        unlinkSync(abs);
      }
    } else {
      let content: Buffer | null = null;
      try {
        content = await gitBuffer(this.workspaceRoot, ['show', `${file.baseTree}:${relPath}`]);
      } catch {
        content = null;
      }
      if (content === null) {
        if (existsSync(abs)) {
          unlinkSync(abs);
        }
      } else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    this.pending.delete(relPath);
    this.invalidate();
  }

  async rejectAll(): Promise<void> {
    for (const rel of [...this.pending.keys()]) {
      await this.reject(rel);
    }
  }
}

export async function assertGitRepo(root: string): Promise<void> {
  if (!existsSync(join(root, '.git'))) {
    throw new Error('Workspace is not a git repository. Accept/Reject need git.');
  }
  await git(root, ['rev-parse', '--is-inside-work-tree']);
}

/**
 * Changed files between two trees, with counts and status, in two git calls
 * (numstat for counts, name-status for added / deleted). `paths` narrows the diff.
 */
async function diffTrees(root: string, base: string, after: string, paths?: string[]): Promise<FileChange[]> {
  const scope = paths?.length ? ['--', ...paths] : [];
  const [numstat, names] = await Promise.all([
    git(root, ['diff', '--numstat', '-z', '--no-renames', base, after, ...scope]),
    git(root, ['diff', '--name-status', '-z', '--no-renames', base, after, ...scope]),
  ]);
  const status = new Map<string, FileChange['status']>();
  const ns = names.split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const code = ns[i];
    const rel = ns[i + 1];
    if (!rel) continue;
    status.set(rel, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
  }
  const files: FileChange[] = [];
  // -z numstat: "added\tdeleted\tpath\0" per file
  for (const entry of numstat.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const relPath = m[3];
    files.push({
      path: join(root, relPath),
      relPath,
      additions: m[1] === '-' ? 0 : Number(m[1]),
      deletions: m[2] === '-' ? 0 : Number(m[2]),
      baseTree: base,
      status: status.get(relPath) ?? 'modified',
    });
  }
  return files;
}

async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function git(
  cwd: string,
  args: string[],
  envExtra: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, ...envExtra },
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export function toRelPath(workspaceRoot: string, absPath: string): string {
  return relative(workspaceRoot, absPath).replace(/\\/g, '/');
}
