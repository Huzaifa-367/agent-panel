import * as vscode from 'vscode';
import { join } from 'node:path';
import type { ChangeTracker, FileChange } from './changes';
import {
  buildReviewSpots,
  type HunkLocation,
  type ReviewSpot,
} from './diff_hunks';
import { changedSpan, clip, diffLines, removedSummary } from './linediff';

const BASE_SCHEME = 'agent-panel-base';

export interface ReviewHost {
  getTracker(): ChangeTracker | undefined;
  workspaceRoot(): string | undefined;
  baseContentProvider: {
    set(path: string, text: string): void;
  };
  onPendingChanged(): void;
}

/**
 * In-editor review: decorations, hunk/file navigation, status bar, tree, CodeLens.
 * Mirrors the Cursor-style “walk your edits” flow using public VS Code APIs.
 */
export class ReviewController implements vscode.TreeDataProvider<FileChange>, vscode.CodeLensProvider {
  private readonly addedDeco: vscode.TextEditorDecorationType;
  private readonly modifiedDeco: vscode.TextEditorDecorationType;
  private readonly deletedDeco: vscode.TextEditorDecorationType;
  private readonly deletedEndDeco: vscode.TextEditorDecorationType;
  /** The changed characters inside a modified line. */
  private readonly charDeco: vscode.TextEditorDecorationType;
  /** Ghost text after a line: the removed or old lines, as Cursor shows them inline. */
  private readonly ghostDeco: vscode.TextEditorDecorationType;
  /** Original text per pending file, to diff the live buffer against. */
  private baseText = new Map<string, string>();
  private recompute = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly currentDeco: vscode.TextEditorDecorationType;
  private readonly status: vscode.StatusBarItem;
  private readonly treeView: vscode.TreeView<FileChange>;
  private readonly onDidChangeTree = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTree.event;
  private readonly onDidChangeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeLenses.event;

  private fileHunks = new Map<string, HunkLocation[]>();
  private spots: ReviewSpot[] = [];
  private spotIndex = 0;
  private activeRel: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ReviewHost,
  ) {
    // All colours come from the theme, so highlights match the editor's own diff colours.
    this.addedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.modifiedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    // A deletion has no line left to colour: a red rule sits between the lines instead.
    this.deletedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '2px 0 0 0',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.deletedEndDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 2px 0',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.charDeco = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      borderRadius: '2px',
    });
    this.ghostDeco = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.currentDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      outline: '1px solid',
      outlineColor: new vscode.ThemeColor('focusBorder'),
      overviewRulerColor: new vscode.ThemeColor('focusBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
    });

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'agentPanel.review.pickFile';
    this.status.tooltip = 'Agent Panel review — click to jump to a file';

    this.treeView = vscode.window.createTreeView('agentPanel.changes', {
      treeDataProvider: this,
      showCollapseAll: false,
    });

    context.subscriptions.push(
      this.addedDeco,
      this.modifiedDeco,
      this.deletedDeco,
      this.deletedEndDeco,
      this.charDeco,
      this.ghostDeco,
      this.currentDeco,
      this.status,
      this.treeView,
      this.onDidChangeTree,
      this.onDidChangeLenses,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) void this.paintEditor(ed);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const rel = this.relForUri(e.document.uri);
        if (rel && this.baseText.has(rel)) this.scheduleRecompute(rel, e.document);
      }),
    );

    this.registerCommands();
  }

  private registerCommands(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('agentPanel.review.nextChange', () => this.nextChange()),
      vscode.commands.registerCommand('agentPanel.review.prevChange', () => this.prevChange()),
      vscode.commands.registerCommand('agentPanel.review.nextFile', () => this.nextFile()),
      vscode.commands.registerCommand('agentPanel.review.prevFile', () => this.prevFile()),
      vscode.commands.registerCommand('agentPanel.review.acceptFile', (rel?: string) =>
        this.acceptCurrent(rel),
      ),
      vscode.commands.registerCommand('agentPanel.review.rejectFile', (rel?: string) =>
        this.rejectCurrent(rel),
      ),
      vscode.commands.registerCommand('agentPanel.review.acceptAll', () => this.acceptAll()),
      vscode.commands.registerCommand('agentPanel.review.rejectAll', () => this.rejectAll()),
      vscode.commands.registerCommand('agentPanel.review.openDiff', (rel?: string) =>
        this.openDiffCurrent(rel),
      ),
      vscode.commands.registerCommand('agentPanel.review.pickFile', () => this.pickFile()),
      vscode.commands.registerCommand('agentPanel.review.refresh', () => this.refresh()),
      vscode.commands.registerCommand('agentPanel.review.openFile', (relPath: string) =>
        this.openFile(relPath, { revealFirst: true }),
      ),
      vscode.commands.registerCommand(
        'agentPanel.review.gotoSpot',
        (relPath: string, hunkIndex: number) => this.gotoHunk(relPath, hunkIndex),
      ),
    );
  }

  getTreeItem(element: FileChange): vscode.TreeItem {
    const name = element.relPath.split('/').pop() ?? element.relPath;
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = `${element.relPath}  +${element.additions} −${element.deletions}`;
    item.resourceUri = vscode.Uri.file(element.path);
    item.contextValue = 'agentPanel.change';
    item.iconPath = new vscode.ThemeIcon(
      element.status === 'added'
        ? 'diff-added'
        : element.status === 'deleted'
          ? 'diff-removed'
          : 'diff-modified',
    );
    item.command = {
      command: 'agentPanel.review.openFile',
      title: 'Open',
      arguments: [element.relPath],
    };
    return item;
  }

  getChildren(): FileChange[] {
    return this.host.getTracker()?.getPending() ?? [];
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const rel = this.relForUri(document.uri);
    if (!rel || !this.fileHunks.has(rel)) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, {
        title: '$(check) Accept file',
        command: 'agentPanel.review.acceptFile',
        arguments: [rel],
      }),
      new vscode.CodeLens(top, {
        title: '$(discard) Reject file',
        command: 'agentPanel.review.rejectFile',
        arguments: [rel],
      }),
      new vscode.CodeLens(top, {
        title: '$(diff) Open diff',
        command: 'agentPanel.review.openDiff',
        arguments: [rel],
      }),
      new vscode.CodeLens(top, {
        title: '$(arrow-down) Next change',
        command: 'agentPanel.review.nextChange',
      }),
    );
    const hunks = this.fileHunks.get(rel) ?? [];
    for (let i = 0; i < hunks.length; i++) {
      const h = hunks[i];
      const range = new vscode.Range(h.line, 0, h.line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Change ${i + 1}/${hunks.length}`,
          command: 'agentPanel.review.gotoSpot',
          arguments: [rel, i],
        }),
      );
    }
    return lenses;
  }

  /** Rebuild hunks from the tracker and optionally open the first edit. */
  async refresh(opts?: { openFirst?: boolean }): Promise<void> {
    const tracker = this.host.getTracker();
    const root = this.host.workspaceRoot();
    this.fileHunks.clear();
    this.spots = [];
    if (!tracker || !root) {
      this.spotIndex = 0;
      this.activeRel = undefined;
      this.updateStatus();
      this.onDidChangeTree.fire();
      this.onDidChangeLenses.fire();
      await vscode.commands.executeCommand('setContext', 'agentPanel.hasReview', false);
      this.clearDecorations();
      return;
    }
    const pending = tracker.getPending();
    const parsed: { relPath: string; hunks: HunkLocation[] }[] = [];
    this.baseText.clear();
    for (const f of pending) {
      if (f.status === 'deleted') {
        parsed.push({ relPath: f.relPath, hunks: [] });
        continue;
      }
      try {
        // Diff the editor's text (saved or not) against the original: exact positions.
        const base = f.status === 'added' ? '' : ((await tracker.baseContent(f.relPath)) ?? '');
        this.baseText.set(f.relPath, base);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f.path));
        const hunks = toHunks(base, doc.getText(), f.status === 'added');
        this.fileHunks.set(f.relPath, hunks);
        parsed.push({ relPath: f.relPath, hunks });
      } catch {
        parsed.push({ relPath: f.relPath, hunks: [] });
      }
    }
    this.spots = buildReviewSpots(parsed);
    if (this.spotIndex >= this.spots.length) this.spotIndex = Math.max(0, this.spots.length - 1);
    this.activeRel = this.spots[this.spotIndex]?.relPath;
    this.updateStatus();
    this.onDidChangeTree.fire();
    this.onDidChangeLenses.fire();
    await vscode.commands.executeCommand(
      'setContext',
      'agentPanel.hasReview',
      this.spots.length > 0,
    );
    await this.paintOpenEditors();
    if (opts?.openFirst && this.spots.length) {
      this.spotIndex = 0;
      await this.revealSpot(this.spots[0], true);
    }
  }

  async openFile(
    relPath: string,
    opts?: { revealFirst?: boolean; sideBySide?: boolean },
  ): Promise<void> {
    if (opts?.sideBySide) {
      await this.openDiff(relPath);
      return;
    }
    const tracker = this.host.getTracker();
    const root = this.host.workspaceRoot();
    if (!tracker || !root) return;
    const file = tracker.getPending().find((f) => f.relPath === relPath);
    if (!file) {
      const uri = vscode.Uri.file(join(root, relPath));
      await vscode.window.showTextDocument(uri);
      return;
    }
    if (file.status === 'deleted') {
      await this.openDiff(relPath);
      return;
    }
    const idx = this.spots.findIndex((s) => s.relPath === relPath);
    if (idx >= 0) this.spotIndex = idx;
    this.activeRel = relPath;
    const uri = vscode.Uri.file(join(root, relPath));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: false,
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    await this.paintEditor(editor);
    if (opts?.revealFirst !== false) {
      const spot = this.spots[this.spotIndex];
      if (spot) await this.revealInEditor(editor, spot);
    }
    this.updateStatus();
  }

  async openDiff(relPath: string): Promise<void> {
    const tracker = this.host.getTracker();
    const root = this.host.workspaceRoot();
    if (!tracker || !root) return;
    const base = await tracker.baseContent(relPath);
    const left = vscode.Uri.parse(`${BASE_SCHEME}:${relPath}`);
    this.host.baseContentProvider.set(relPath, base ?? '');
    const right = vscode.Uri.file(join(root, relPath));
    const file = tracker.getPending().find((f) => f.relPath === relPath);
    const title =
      file?.status === 'deleted'
        ? `${relPath} (deleted)`
        : file?.status === 'added'
          ? `${relPath} (new)`
          : `${relPath} (base ↔ working)`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
    this.activeRel = relPath;
    const idx = this.spots.findIndex((s) => s.relPath === relPath);
    if (idx >= 0) this.spotIndex = idx;
    this.updateStatus();
  }

  async nextChange(): Promise<void> {
    if (!this.spots.length) return;
    this.spotIndex = (this.spotIndex + 1) % this.spots.length;
    await this.revealSpot(this.spots[this.spotIndex], true);
  }

  async prevChange(): Promise<void> {
    if (!this.spots.length) return;
    this.spotIndex = (this.spotIndex - 1 + this.spots.length) % this.spots.length;
    await this.revealSpot(this.spots[this.spotIndex], true);
  }

  async nextFile(): Promise<void> {
    if (!this.spots.length) return;
    const cur = this.spots[this.spotIndex]?.relPath;
    let i = this.spotIndex;
    for (let n = 0; n < this.spots.length; n++) {
      i = (i + 1) % this.spots.length;
      if (this.spots[i].relPath !== cur) {
        this.spotIndex = i;
        await this.revealSpot(this.spots[i], true);
        return;
      }
    }
  }

  async prevFile(): Promise<void> {
    if (!this.spots.length) return;
    const cur = this.spots[this.spotIndex]?.relPath;
    let i = this.spotIndex;
    for (let n = 0; n < this.spots.length; n++) {
      i = (i - 1 + this.spots.length) % this.spots.length;
      if (this.spots[i].relPath !== cur) {
        this.spotIndex = i;
        await this.revealSpot(this.spots[i], true);
        return;
      }
    }
  }

  async acceptCurrent(relPath?: string | FileChange): Promise<void> {
    const path = this.resolveRel(relPath);
    if (!path) return;
    this.host.getTracker()?.accept(path);
    await this.afterMutate();
  }

  async rejectCurrent(relPath?: string | FileChange): Promise<void> {
    const path = this.resolveRel(relPath);
    if (!path) return;
    // From a keybinding or the palette nothing says which file is meant: ask before discarding work.
    if (!relPath) {
      const pick = await vscode.window.showWarningMessage(`Reject the agent's changes to ${path}? The file goes back to how it was before.`, { modal: true }, 'Reject');
      if (pick !== 'Reject') return;
    }
    await this.host.getTracker()?.reject(path);
    await this.afterMutate();
  }

  async acceptAll(): Promise<void> {
    this.host.getTracker()?.acceptAll();
    await this.afterMutate();
  }

  async rejectAll(): Promise<void> {
    await this.host.getTracker()?.rejectAll();
    await this.afterMutate();
  }

  async openDiffCurrent(relPath?: string | FileChange): Promise<void> {
    const path = this.resolveRel(relPath);
    if (path) await this.openDiff(path);
  }

  private resolveRel(relPath?: string | FileChange): string | undefined {
    if (typeof relPath === 'string' && relPath) return relPath;
    if (relPath && typeof relPath === 'object' && 'relPath' in relPath) {
      return relPath.relPath;
    }
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      const fromEditor = this.relForUri(ed.document.uri);
      if (fromEditor && this.fileHunks.has(fromEditor)) return fromEditor;
      // Focus is on an unrelated file (e.g. Alt+Backspace to delete a word): act on nothing.
      if (ed.document.uri.scheme === 'file') return undefined;
    }
    return this.activeRel ?? this.spots[this.spotIndex]?.relPath;
  }

  async gotoHunk(relPath: string, hunkIndex: number): Promise<void> {
    const idx = this.spots.findIndex(
      (s) => s.relPath === relPath && s.hunkIndex === hunkIndex,
    );
    if (idx < 0) {
      await this.openFile(relPath, { revealFirst: true });
      return;
    }
    this.spotIndex = idx;
    await this.revealSpot(this.spots[idx], true);
  }

  async pickFile(): Promise<void> {
    const pending = this.host.getTracker()?.getPending() ?? [];
    if (!pending.length) {
      void vscode.window.showInformationMessage('No pending Agent Panel changes.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      pending.map((f) => ({
        label: f.relPath.split('/').pop() ?? f.relPath,
        description: f.relPath,
        detail: `+${f.additions} −${f.deletions} · ${f.status}`,
        relPath: f.relPath,
      })),
      { placeHolder: 'Jump to an edited file' },
    );
    if (picked) await this.openFile(picked.relPath, { revealFirst: true });
  }

  private async afterMutate(): Promise<void> {
    this.host.onPendingChanged();
    await this.refresh();
  }

  private async revealSpot(spot: ReviewSpot, open: boolean): Promise<void> {
    this.activeRel = spot.relPath;
    this.updateStatus();
    if (open) {
      await this.openFile(spot.relPath, { revealFirst: false });
    }
    const root = this.host.workspaceRoot();
    if (!root) return;
    const tracker = this.host.getTracker();
    const file = tracker?.getPending().find((f) => f.relPath === spot.relPath);
    if (file?.status === 'deleted') {
      await this.openDiff(spot.relPath);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && this.relForUri(editor.document.uri) === spot.relPath) {
      await this.revealInEditor(editor, spot);
      await this.paintEditor(editor);
    }
  }

  private async revealInEditor(editor: vscode.TextEditor, spot: ReviewSpot): Promise<void> {
    const max = Math.max(0, editor.document.lineCount - 1);
    const start = Math.min(spot.line, max);
    const end = Math.min(spot.endLine, max);
    const range = new vscode.Range(start, 0, end, editor.document.lineAt(end).text.length);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(this.currentDeco, [range]);
  }

  private async paintOpenEditors(): Promise<void> {
    for (const ed of vscode.window.visibleTextEditors) {
      await this.paintEditor(ed);
    }
  }

  /** Re-diff one file shortly after its text changes, then repaint. */
  private scheduleRecompute(rel: string, doc: vscode.TextDocument): void {
    clearTimeout(this.recompute.get(rel));
    this.recompute.set(
      rel,
      setTimeout(() => {
        this.recompute.delete(rel);
        const base = this.baseText.get(rel);
        if (base === undefined) return;
        const added = this.host.getTracker()?.getPending().find((f) => f.relPath === rel)?.status === 'added';
        this.fileHunks.set(rel, toHunks(base, doc.getText(), added));
        const parsed = [...this.fileHunks.entries()].map(([relPath, hunks]) => ({ relPath, hunks }));
        this.spots = buildReviewSpots(parsed);
        if (this.spotIndex >= this.spots.length) this.spotIndex = Math.max(0, this.spots.length - 1);
        this.updateStatus();
        this.onDidChangeLenses.fire();
        for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) void this.paintEditor(ed);
      }, 120),
    );
  }

  private async paintEditor(editor: vscode.TextEditor): Promise<void> {
    const rel = this.relForUri(editor.document.uri);
    if (!rel || !this.fileHunks.has(rel)) {
      for (const d of [this.addedDeco, this.modifiedDeco, this.deletedDeco, this.deletedEndDeco, this.charDeco, this.ghostDeco]) editor.setDecorations(d, []);
      if (this.activeRel !== rel) editor.setDecorations(this.currentDeco, []);
      return;
    }
    if (this.activeRel !== rel) {
      this.activeRel = rel;
      const idx = this.spots.findIndex((s) => s.relPath === rel);
      if (idx >= 0) this.spotIndex = idx;
      this.updateStatus();
    }
    const doc = editor.document;
    const hunks = this.fileHunks.get(rel) ?? [];
    const added: vscode.DecorationOptions[] = [];
    const modified: vscode.DecorationOptions[] = [];
    const deleted: vscode.DecorationOptions[] = [];
    const deletedEnd: vscode.DecorationOptions[] = [];
    const chars: vscode.DecorationOptions[] = [];
    const ghosts: vscode.DecorationOptions[] = [];
    const lineCount = doc.lineCount;
    const max = Math.max(0, lineCount - 1);
    for (const h of hunks) {
      const removed = h.removed ?? [];
      const hover = removed.length ? removedHover(removed, doc.languageId, h.added.length ? 'Replaced' : 'Removed') : undefined;
      for (const a of h.added) {
        const s = Math.min(a.start, max);
        const e = Math.min(a.end, max);
        const range = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
        (removed.length ? modified : added).push({ range, hoverMessage: hover });
      }
      if (!h.added.length && removed.length) {
        // Removed lines sat just above this line; past the end, below the last one.
        if (h.line > max) deletedEnd.push({ range: new vscode.Range(max, 0, max, 0), hoverMessage: hover });
        else deleted.push({ range: new vscode.Range(h.line, 0, h.line, 0), hoverMessage: hover });
        // Show what went, as ghost text on the line just above the gap.
        const at = Math.min(Math.max(0, h.line - 1), max);
        ghosts.push(ghost(at, doc.lineAt(at).text.length, removedSummary(removed), hover));
      } else if (removed.length && h.added.length) {
        // Changed lines: mark the characters that differ, and show the old line after the new one.
        const first = Math.min(h.added[0].start, max);
        const last = Math.min(h.added[h.added.length - 1].end, max);
        const now: string[] = [];
        for (let l = first; l <= last; l++) now.push(doc.lineAt(l).text);
        const pairs = Math.min(now.length, removed.length);
        for (let i = 0; i < pairs; i++) {
          const line = first + i;
          const span = changedSpan(removed[i], now[i]);
          if (span && span.end > span.start) chars.push({ range: new vscode.Range(line, span.start, line, span.end), hoverMessage: hover });
          if (removed[i].trim() !== now[i].trim()) ghosts.push(ghost(line, now[i].length, `was: ${clip(removed[i].trim())}`, hover));
        }
        if (removed.length > pairs) {
          ghosts.push(ghost(last, doc.lineAt(last).text.length, removedSummary(removed.slice(pairs)), hover));
        }
      }
    }
    editor.setDecorations(this.addedDeco, added);
    editor.setDecorations(this.modifiedDeco, modified);
    editor.setDecorations(this.deletedDeco, deleted);
    editor.setDecorations(this.deletedEndDeco, deletedEnd);
    editor.setDecorations(this.charDeco, chars);
    editor.setDecorations(this.ghostDeco, ghosts);
    const spot = this.spots[this.spotIndex];
    if (spot && spot.relPath === rel) {
      const s = Math.min(spot.line, max);
      const e = Math.min(spot.endLine, max);
      editor.setDecorations(this.currentDeco, [new vscode.Range(s, 0, e, doc.lineAt(e).text.length)]);
    }
  }

  private clearDecorations(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      for (const d of [this.addedDeco, this.modifiedDeco, this.deletedDeco, this.deletedEndDeco, this.charDeco, this.ghostDeco, this.currentDeco]) ed.setDecorations(d, []);
    }
  }

  private updateStatus(): void {
    const pending = this.host.getTracker()?.getPending() ?? [];
    if (!pending.length) {
      this.status.hide();
      return;
    }
    const files = pending.length;
    const spot = this.spots[this.spotIndex];
    const changeN = this.spots.length;
    const changeI = changeN ? this.spotIndex + 1 : 0;
    const fileNames = [...new Set(this.spots.map((s) => s.relPath))];
    const fileI = spot ? fileNames.indexOf(spot.relPath) + 1 : 0;
    const name = spot?.relPath.split('/').pop() ?? 'changes';
    this.status.text = `$(git-compare) Agent Panel: ${name} (${fileI}/${files}) · change ${changeI}/${changeN}`;
    this.status.show();
  }

  private relForUri(uri: vscode.Uri): string | undefined {
    const root = this.host.workspaceRoot();
    if (!root || uri.scheme !== 'file') return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!rel || rel === uri.fsPath) {
      // fallback
      const normalized = uri.fsPath.replace(/\\/g, '/');
      const rootN = root.replace(/\\/g, '/');
      if (normalized.startsWith(rootN + '/')) {
        return normalized.slice(rootN.length + 1);
      }
      return undefined;
    }
    return rel.replace(/\\/g, '/');
  }
}

/** Changes between the original and the live text, as review hunks (0-based lines). */
export function toHunks(base: string, text: string, isNew = false): HunkLocation[] {
  if (isNew) {
    const lines = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    return [{ line: 0, endLine: lines - 1, added: [{ start: 0, end: lines - 1 }], deletedBefore: [], oldStart: 0, newStart: 1, removed: [] }];
  }
  return diffLines(base, text).map((c) => ({
    line: c.newStart,
    endLine: c.newCount ? c.newStart + c.newCount - 1 : c.newStart,
    added: c.newCount ? [{ start: c.newStart, end: c.newStart + c.newCount - 1 }] : [],
    deletedBefore: c.newCount ? [] : [c.newStart],
    oldStart: 0,
    newStart: c.newStart + 1,
    removed: c.removed,
  }));
}

/** Ghost text at the end of a line, in the theme's removed colour. */
function ghost(line: number, col: number, text: string, hover?: vscode.MarkdownString): vscode.DecorationOptions {
  return {
    range: new vscode.Range(line, col, line, col),
    hoverMessage: hover,
    renderOptions: {
      after: {
        contentText: `  ${text}`,
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        fontStyle: 'italic',
        margin: '0 0 0 1.5em',
      },
    },
  };
}

/** Hover with the old lines, in the file's language. */
function removedHover(lines: string[], languageId: string, verb: string): vscode.MarkdownString {
  const shown = lines.slice(0, 40);
  const md = new vscode.MarkdownString(`**${verb} ${lines.length} line${lines.length === 1 ? '' : 's'}**`);
  md.appendCodeblock(shown.join('\n') + (lines.length > shown.length ? '\n…' : ''), languageId);
  return md;
}
