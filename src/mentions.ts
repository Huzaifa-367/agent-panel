import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Thread } from './threads';

const exec = promisify(execFile);

/**
 * The @ menu, grouped the way Cursor's is: recent files and context categories when
 * empty, grouped matches while typing, and a drill-in list per category.
 */

export type MentionKind =
  | 'file'
  | 'folder'
  | 'symbol'
  | 'git-diff'
  | 'commit'
  | 'problems'
  | 'branch'
  | 'chat'
  | 'rule'
  | 'selection'
  | 'category';

export type MentionScope = 'files' | 'code' | 'git' | 'chats' | 'rules';

export interface MentionItem {
  kind: MentionKind;
  /** Path, symbol location, commit sha, thread id, or the category's scope. */
  id: string;
  label: string;
  detail?: string;
  icon: string;
  /** Characters of `label` to show in bold. */
  match?: number[];
}

export interface MentionGroup {
  label: string;
  items: MentionItem[];
}

const EXCLUDE = '**/{node_modules,dist,dist-test,vendor,.git,.next,build,out,coverage}/**';
const RULE_GLOB = '{AGENTS.md,CLAUDE.md,.cursorrules,.claude/CLAUDE.md,.cursor/rules/**/*.{md,mdc},**/AGENTS.md,**/CLAUDE.md}';

const CATEGORIES: { scope: MentionScope | 'problems' | 'selection' | 'branch'; label: string; icon: string; detail: string }[] = [
  { scope: 'files', label: 'Files & folders', icon: 'files', detail: '' },
  { scope: 'code', label: 'Code', icon: 'symbol-method', detail: 'Functions, classes, types' },
  { scope: 'git', label: 'Git', icon: 'git-commit', detail: 'Working changes, commits' },
  { scope: 'problems', label: 'Problems', icon: 'warning', detail: 'Errors and warnings in the workspace' },
  { scope: 'branch', label: 'Branch (diff with main)', icon: 'git-branch', detail: 'Everything this branch changed' },
  { scope: 'chats', label: 'Past chats', icon: 'comment-discussion', detail: '' },
  { scope: 'rules', label: 'Rules', icon: 'law', detail: 'AGENTS.md, CLAUDE.md, Cursor rules' },
];

export class MentionService {
  private files: string[] = [];
  private filesAt = 0;
  private loading?: Promise<void>;

  constructor(
    private readonly root: () => string | undefined,
    private readonly threads: () => Thread[],
    private readonly currentThreadId: () => string,
  ) {}

  /** Build the file index ahead of the first @. */
  warm(): void {
    void this.index();
  }

  async search(query: string, scope?: MentionScope): Promise<MentionGroup[]> {
    const q = query.trim();
    if (scope === 'files') return this.fileGroups(q, 40, 20);
    if (scope === 'code') return [{ label: 'Code', items: await this.symbols(q, 30) }];
    if (scope === 'git') return [{ label: 'Git', items: await this.git(q) }];
    if (scope === 'chats') return [{ label: 'Past chats', items: this.chats(q, 30) }];
    if (scope === 'rules') return [{ label: 'Rules', items: await this.rules(q) }];

    if (!q) {
      const groups: MentionGroup[] = [];
      const recent = this.recentFiles();
      if (recent.length) groups.push({ label: 'Recent', items: recent });
      const cats: MentionItem[] = CATEGORIES.map((c) => ({
        kind: c.scope === 'problems' ? 'problems' : c.scope === 'branch' ? 'branch' : 'category',
        id: c.scope,
        label: c.label,
        detail: c.scope === 'problems' ? this.problemCount() : c.detail,
        icon: c.icon,
      }));
      const sel = this.selectionItem();
      if (sel) cats.push(sel);
      groups.push({ label: 'Add context', items: cats });
      return groups;
    }

    const groups = await this.fileGroups(q, 8, 3);
    if (q.length >= 2) {
      const code = await this.symbols(q, 5);
      if (code.length) groups.push({ label: 'Code', items: code });
    }
    const chats = this.chats(q, 3);
    if (chats.length) groups.push({ label: 'Past chats', items: chats });
    const rules = await this.rules(q);
    if (rules.length) groups.push({ label: 'Rules', items: rules.slice(0, 3) });
    return groups.filter((g) => g.items.length);
  }

  // ----- files and folders -----

  private async index(): Promise<string[]> {
    if (Date.now() - this.filesAt < 30_000 && this.files.length) return this.files;
    if (!this.loading) {
      this.loading = (async () => {
        // git knows the project's files (tracked and new, minus ignored) in milliseconds.
        const root = this.root();
        let files: string[] = [];
        if (root) {
          try {
            const { stdout } = await exec('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
            files = stdout.split('\0').filter(Boolean);
          } catch {
            files = [];
          }
        }
        if (!files.length) {
          const found = await vscode.workspace.findFiles('**/*', EXCLUDE, 20_000);
          files = found.map((u) => vscode.workspace.asRelativePath(u, false));
        }
        this.files = files.sort();
        this.filesAt = Date.now();
      })().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
    return this.files;
  }

  private async fileGroups(q: string, fileLimit: number, folderLimit: number): Promise<MentionGroup[]> {
    const files = await this.index();
    if (!q) {
      return [{ label: 'Files', items: this.recentFiles().concat(files.slice(0, fileLimit).map(fileItem)).slice(0, fileLimit) }];
    }
    const scoredFiles = rank(files, q, (f) => f).slice(0, fileLimit);
    const folders = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join('/'));
    }
    const scoredFolders = rank([...folders], q, (f) => f).slice(0, folderLimit);
    const groups: MentionGroup[] = [];
    if (scoredFiles.length) {
      groups.push({ label: 'Files', items: scoredFiles.map(({ value, match }) => ({ ...fileItem(value), match })) });
    }
    if (scoredFolders.length) {
      groups.push({
        label: 'Folders',
        items: scoredFolders.map(({ value, match }) => ({ ...folderItem(value), match })),
      });
    }
    return groups;
  }

  private recentFiles(): MentionItem[] {
    const root = this.root();
    const seen = new Set<string>();
    const out: MentionItem[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        const uri = input?.uri;
        if (!uri || uri.scheme !== 'file' || (root && !uri.fsPath.startsWith(root))) continue;
        const rel = vscode.workspace.asRelativePath(uri, false);
        if (seen.has(rel)) continue;
        seen.add(rel);
        out.push(fileItem(rel));
      }
    }
    return out.slice(0, 6);
  }

  // ----- code symbols -----

  private async symbols(q: string, limit: number): Promise<MentionItem[]> {
    try {
      if (!q) {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc) return [];
        const syms =
          (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
        const rel = vscode.workspace.asRelativePath(doc.uri, false);
        return flatten(syms)
          .slice(0, limit)
          .map((s) => symbolItem(s.name, s.kind, rel, s.range.start.line));
      }
      const syms =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q)) ?? [];
      return syms
        .filter((s) => !/node_modules|\/dist\//.test(s.location.uri.fsPath))
        .slice(0, limit)
        .map((s) =>
          symbolItem(s.name, s.kind, vscode.workspace.asRelativePath(s.location.uri, false), s.location.range.start.line),
        );
    } catch {
      return [];
    }
  }

  // ----- git -----

  private async git(q: string): Promise<MentionItem[]> {
    const root = this.root();
    if (!root) return [];
    const items: MentionItem[] = [];
    if (!q || 'working changes diff'.includes(q.toLowerCase())) {
      items.push({ kind: 'git-diff', id: 'working', label: 'Working changes', detail: 'Uncommitted diff against HEAD', icon: 'diff' });
    }
    try {
      const { stdout } = await exec('git', ['log', '-30', '--format=%h%x09%s%x09%ar'], { cwd: root });
      for (const line of stdout.split('\n')) {
        const [sha, subject, when] = line.split('\t');
        if (!sha || !subject) continue;
        if (q && !`${sha} ${subject}`.toLowerCase().includes(q.toLowerCase())) continue;
        items.push({ kind: 'commit', id: sha, label: subject, detail: `${sha} · ${when}`, icon: 'git-commit' });
      }
    } catch {
      /* not a git repo */
    }
    return items;
  }

  // ----- past chats -----

  private chats(q: string, limit: number): MentionItem[] {
    const current = this.currentThreadId();
    return this.threads()
      .filter((t) => t.id !== current && t.messages.length)
      .filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()))
      .slice(0, limit)
      .map((t) => ({
        kind: 'chat' as const,
        id: t.id,
        label: t.title,
        detail: new Date(t.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        icon: 'comment-discussion',
      }));
  }

  // ----- rules -----

  private async rules(q: string): Promise<MentionItem[]> {
    const found = await vscode.workspace.findFiles(RULE_GLOB, EXCLUDE, 50);
    return found
      .map((u) => vscode.workspace.asRelativePath(u, false))
      .filter((r) => !q || r.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .map((r) => ({ ...fileItem(r), kind: 'rule' as const, icon: 'law' }));
  }

  // ----- problems and selection -----

  private problemCount(): string {
    let errors = 0;
    let warnings = 0;
    for (const [, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors += 1;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
      }
    }
    return `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  }

  private selectionItem(): MentionItem | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) return undefined;
    const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    return {
      kind: 'selection',
      id: `${rel}:${a}-${b}`,
      label: 'Selection',
      detail: `${basename(rel)} ${a === b ? `line ${a}` : `lines ${a}–${b}`}`,
      icon: 'selection',
    };
  }

  // ----- turning mentions into context -----

  /** The context block sent ahead of the user's message. Capped so one mention can't flood the turn. */
  async resolve(items: MentionItem[]): Promise<string> {
    const root = this.root();
    if (!root || !items.length) return '';
    const parts: string[] = [];
    let budget = 120_000;
    const add = (title: string, body: string, lang = '') => {
      const cut = body.length > Math.min(40_000, budget) ? `${body.slice(0, Math.min(40_000, budget))}\n… (cut short)` : body;
      budget -= cut.length;
      parts.push(`### ${title}\n\`\`\`${lang}\n${cut}\n\`\`\``);
    };
    for (const m of items) {
      if (budget <= 0) break;
      try {
        if (m.kind === 'file' || m.kind === 'rule') {
          const text = await readFile(join(root, m.id), 'utf8');
          add(`File: ${m.id}`, text, extOf(m.id));
        } else if (m.kind === 'folder') {
          const files = (await this.index()).filter((f) => f.startsWith(`${m.id}/`)).slice(0, 300);
          add(`Folder: ${m.id} (${files.length} files listed)`, files.join('\n'));
        } else if (m.kind === 'symbol') {
          const [file, line] = splitLoc(m.id);
          const lines = (await readFile(join(root, file), 'utf8')).split('\n');
          add(`${m.label} in ${file}:${line + 1}`, lines.slice(line, line + 60).join('\n'), extOf(file));
        } else if (m.kind === 'git-diff') {
          const { stdout } = await exec('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
          add('Working changes (git diff HEAD)', stdout || '(no changes)', 'diff');
        } else if (m.kind === 'commit') {
          const { stdout } = await exec('git', ['show', '--stat', '--patch', m.id], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
          add(`Commit ${m.id}: ${m.label}`, stdout, 'diff');
        } else if (m.kind === 'branch') {
          const base = await defaultBranch(root);
          const { stdout } = await exec('git', ['diff', `${base}...HEAD`], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
          add(`This branch against ${base}`, stdout || '(no changes)', 'diff');
        } else if (m.kind === 'problems') {
          add('Problems in the workspace', this.problemsText());
        } else if (m.kind === 'selection') {
          const ed = vscode.window.activeTextEditor;
          if (ed && !ed.selection.isEmpty) {
            add(`Selection: ${m.detail}`, ed.document.getText(ed.selection), ed.document.languageId);
          }
        } else if (m.kind === 'chat') {
          const t = this.threads().find((x) => x.id === m.id);
          if (t) {
            const text = t.messages
              .filter((x) => x.role !== 'system')
              .map((x) => `${x.role === 'user' ? 'User' : x.engine ?? 'Assistant'}: ${x.text}`)
              .join('\n\n');
            add(`Past chat: ${t.title}`, text.slice(-12_000));
          }
        }
      } catch (err) {
        parts.push(`### ${m.label}\n(could not read: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return parts.length ? `The user attached this context:\n\n${parts.join('\n\n')}\n\n---\n\n` : '';
  }

  private problemsText(): string {
    const lines: string[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        lines.push(`${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1} ${sev}: ${d.message}`);
        if (lines.length >= 200) return lines.join('\n');
      }
    }
    return lines.join('\n') || 'No errors or warnings.';
  }
}

// ----- helpers -----

/** The repo's main branch: origin's default, else main, else master. */
export async function defaultBranch(root: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: root });
    if (stdout.trim()) return stdout.trim();
  } catch {
    /* no remote default */
  }
  for (const b of ['main', 'master']) {
    try {
      await exec('git', ['rev-parse', '--verify', b], { cwd: root });
      return b;
    } catch {
      /* try the next */
    }
  }
  return 'HEAD';
}

function basename(p: string): string {
  return p.split('/').pop() || p;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p);
  return m ? m[1] : '';
}

function splitLoc(id: string): [string, number] {
  const i = id.lastIndexOf(':');
  return [id.slice(0, i), Number(id.slice(i + 1)) || 0];
}

function fileItem(rel: string): MentionItem {
  return { kind: 'file', id: rel, label: basename(rel), detail: dirname(rel), icon: iconFor(rel) };
}

function folderItem(rel: string): MentionItem {
  return { kind: 'folder', id: rel, label: basename(rel), detail: dirname(rel), icon: 'folder' };
}

function symbolItem(name: string, kind: vscode.SymbolKind, file: string, line: number): MentionItem {
  return {
    kind: 'symbol',
    id: `${file}:${line}`,
    label: name,
    detail: `${basename(file)}:${line + 1}`,
    icon: SYMBOL_ICON[kind] ?? 'symbol-misc',
  };
}

const SYMBOL_ICON: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Class]: 'symbol-class',
  [vscode.SymbolKind.Method]: 'symbol-method',
  [vscode.SymbolKind.Function]: 'symbol-method',
  [vscode.SymbolKind.Constructor]: 'symbol-method',
  [vscode.SymbolKind.Interface]: 'symbol-interface',
  [vscode.SymbolKind.Variable]: 'symbol-variable',
  [vscode.SymbolKind.Constant]: 'symbol-constant',
  [vscode.SymbolKind.Enum]: 'symbol-enum',
  [vscode.SymbolKind.Property]: 'symbol-property',
  [vscode.SymbolKind.Field]: 'symbol-field',
  [vscode.SymbolKind.Module]: 'symbol-namespace',
};

function iconFor(rel: string): string {
  const ext = extOf(rel).toLowerCase();
  if (['md', 'mdc', 'txt'].includes(ext)) return 'markdown';
  if (['json', 'yml', 'yaml', 'toml', 'env'].includes(ext)) return 'json';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'file-media';
  return 'file-code';
}

function flatten(syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const out: vscode.DocumentSymbol[] = [];
  const walk = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      out.push(s);
      if (s.children?.length) walk(s.children);
    }
  };
  walk(syms);
  return out;
}

/**
 * Fuzzy rank: every query character must appear in order. Matches in the file name
 * beat matches in the folder path; contiguous runs and word starts score higher.
 */
export function rank<T>(values: T[], q: string, key: (v: T) => string): { value: T; match: number[] }[] {
  const query = q.toLowerCase().replace(/\s+/g, '');
  const out: { value: T; score: number; match: number[] }[] = [];
  for (const value of values) {
    const full = key(value);
    const name = basename(full);
    const offset = full.length - name.length;
    const inName = subseq(name.toLowerCase(), query);
    const hit = inName ?? subseq(full.toLowerCase(), query);
    if (!hit) continue;
    let score = inName ? 100 : 0;
    for (let i = 1; i < hit.length; i += 1) if (hit[i] === hit[i - 1] + 1) score += 5;
    if (inName && hit[0] === 0) score += 20;
    score -= full.length * 0.1;
    // Bold positions are relative to the label, which is the name.
    const match = inName ? hit : hit.filter((i) => i >= offset).map((i) => i - offset);
    out.push({ value, score, match });
  }
  return out.sort((a, b) => b.score - a.score).map(({ value, match }) => ({ value, match }));
}

function subseq(text: string, q: string): number[] | undefined {
  const pos: number[] = [];
  let from = 0;
  // Prefer a contiguous match when there is one.
  const direct = text.indexOf(q);
  if (direct >= 0) return [...q].map((_, i) => direct + i);
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) return undefined;
    pos.push(i);
    from = i + 1;
  }
  return pos;
}
