import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { diffLines, splitLines } from './linediff';

/**
 * The diff of a single edit step, so the step list can show what an edit changed
 * (like Cursor and Claude Code do), with real line numbers. Built from the tool's
 * input and the file as it is just before the edit runs.
 */

export interface StepEdit {
  /** Workspace-relative path. */
  path: string;
  /** Unified diff of this one edit. */
  diff?: string;
  additions?: number;
  deletions?: number;
  /** 0-based line the step points at (Read with an offset, or the first change). */
  line?: number;
}

const MAX_FILE = 2 * 1024 * 1024;
const MAX_PATCH = 60_000;

export function relPath(root: string, file: string): string {
  return (isAbsolute(file) ? relative(root, file) : file).replace(/\\/g, '/');
}

function readText(abs: string): string | null {
  try {
    if (!existsSync(abs) || statSync(abs).size > MAX_FILE) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Path, and for edits the diff, of a tool call. Undefined when the tool has no file. */
export function stepEdit(root: string, tool: string, input: unknown): StepEdit | undefined {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const file = (typeof o.file_path === 'string' && o.file_path) || (typeof o.path === 'string' && o.path) || (typeof o.notebook_path === 'string' && o.notebook_path) || '';
  if (!file) return undefined;
  const abs = isAbsolute(file) ? file : join(root, file);
  const path = relPath(root, abs);
  if (path.startsWith('..')) return { path: abs };
  const t = tool.toLowerCase();

  if (t === 'read' || t.startsWith('read')) {
    const offset = typeof o.offset === 'number' ? Math.max(0, o.offset - 1) : undefined;
    return { path, line: offset };
  }

  const before = readText(abs);
  let after: string | null = null;
  if (t === 'write' || t === 'writetoolcall') {
    after = typeof o.content === 'string' ? o.content : null;
  } else if (t === 'edit' || t === 'multiedit') {
    if (before === null) return { path };
    const edits = (t === 'multiedit' && Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [o]).map((e) => ({
      oldS: typeof e.old_string === 'string' ? e.old_string : '',
      newS: typeof e.new_string === 'string' ? e.new_string : '',
      all: e.replace_all === true,
    }));
    const swap = (text: string, from: string, to: string, all: boolean) => (all ? text.split(from).join(to) : text.replace(from, () => to));
    if (edits.every((e) => !e.oldS || before.includes(e.oldS))) {
      after = before;
      for (const e of edits) if (e.oldS) after = swap(after, e.oldS, e.newS, e.all);
    } else if (edits.every((e) => !e.newS || before.includes(e.newS))) {
      // The CLI already applied it: the file is the "after"; undo the edit to get "before".
      let reversed = before;
      for (const e of [...edits].reverse()) if (e.newS) reversed = swap(reversed, e.newS, e.oldS, e.all);
      return { path, ...makePatch(reversed, before) };
    } else {
      return { path };
    }
  } else {
    return { path };
  }
  if (after === null) return { path };
  return { path, ...makePatch(before ?? '', after) };
}

/** A unified diff with three lines of context, merged where hunks touch. */
export function makePatch(before: string, after: string): Pick<StepEdit, 'diff' | 'additions' | 'deletions' | 'line'> {
  const b = splitLines(after);
  const changes = diffLines(before, after);
  if (!changes.length) return { diff: '', additions: 0, deletions: 0 };
  const CONTEXT = 3;
  let additions = 0;
  let deletions = 0;
  const out: string[] = [];

  // Old-side position of each change: new position minus net lines added before it.
  let shift = 0;
  const located = changes.map((c) => {
    const oldStart = c.newStart - shift;
    shift += c.newCount - c.removed.length;
    return { ...c, oldStart };
  });

  let i = 0;
  while (i < located.length) {
    let j = i;
    // Merge changes whose context would overlap.
    while (j + 1 < located.length && located[j + 1].newStart - (located[j].newStart + located[j].newCount) <= CONTEXT * 2) j += 1;
    const first = located[i];
    const last = located[j];
    const newFrom = Math.max(0, first.newStart - CONTEXT);
    const newTo = Math.min(b.length, last.newStart + last.newCount + CONTEXT);
    const oldFrom = Math.max(0, first.oldStart - CONTEXT);
    const body: string[] = [];
    let nb = newFrom;
    for (let k = i; k <= j; k += 1) {
      const c = located[k];
      while (nb < c.newStart) body.push(` ${b[nb++]}`);
      for (const r of c.removed) body.push(`-${r}`);
      for (let n = 0; n < c.newCount; n += 1) body.push(`+${b[nb++]}`);
      additions += c.newCount;
      deletions += c.removed.length;
    }
    while (nb < newTo) body.push(` ${b[nb++]}`);
    const oldCount = body.filter((l) => !l.startsWith('+')).length;
    const newCount = body.filter((l) => !l.startsWith('-')).length;
    out.push(`@@ -${oldCount ? oldFrom + 1 : oldFrom},${oldCount} +${newCount ? newFrom + 1 : newFrom},${newCount} @@`, ...body);
    i = j + 1;
  }
  let diff = out.join('\n');
  if (diff.length > MAX_PATCH) diff = `${diff.slice(0, MAX_PATCH)}\n@@ … diff cut short @@`;
  return { diff, additions, deletions, line: located[0].newStart };
}
