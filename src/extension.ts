import * as vscode from 'vscode';
import { join } from 'node:path';
import { createClaudeEngine } from './engines/claude';
import { createCursorEngine, type CursorEngine } from './engines/cursor';
import type { AgentEvent, AgentMode, Engine, EngineId, ImageInput, PermissionDecision } from './engines/types';
import { subagentReport } from './engines/types';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stepEdit } from './editdiff';
import { slashItems, cursorSlashItems, expandForCursor } from './commands';
import { tmpdir } from 'node:os';
import { ChangeTracker, assertGitRepo } from './changes';
import {
  ThreadStore,
  createThread,
  titleFromPrompt,
  buildHandoverPrefix,
  enginesUsed,
  filesChanged,
  type Thread,
  type ChatMessage,
  type StepRecord,
  type ThreadDefaults,
  type TurnMeta,
} from './threads';
import { planPrompt, buildPrompt, reviewPrompt } from './handoff';
import { ReviewController } from './review';
import { claudeCatalog, findVariant, cursorCatalogFromApp, claudeCatalogFromInit, claudeIds, buttonLabel, type ModelCatalog } from './models';
import { describeClaude, type ClaudeInit } from './engines/claude';
import { readCursorAppCatalog } from './cursorCatalog';
import { UsageStore, readCursorAccount, readCursorAppAccount, readCursorSignedIn, type UsageSnapshot } from './usage';
import { MentionService, defaultBranch, type MentionItem, type MentionScope } from './mentions';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { watchFile, unwatchFile, existsSync } from 'node:fs';
import { claudeProjectDir, listClaudeSessions, listCursorChats, loadClaudeSession, loadCursorChat, transcript, type ExternalChat } from './external';

const BASE_SCHEME = 'agent-panel-base';

/** The Agent Panel output channel: turns, errors and timings, for when something goes wrong. */
export let log: vscode.LogOutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Agent Panel', { log: true });
  const cfg = vscode.workspace.getConfiguration('agentPanel');
  const claudePath = cfg.get<string>('claudePath')?.trim() || undefined;
  const cursorPath = cfg.get<string>('cursorPath')?.trim() || undefined;
  const provider = new AgentPanelProvider(context, createClaudeEngine(claudePath), cursorPath ? createCursorEngine(cursorPath) : createCursorEngine());
  const review = new ReviewController(context, {
    getTracker: () => provider.getTracker(),
    workspaceRoot: () => provider.getWorkspaceRoot(),
    baseContentProvider: provider.baseContentProvider,
    onPendingChanged: () => provider.postStatePublic(),
  });
  provider.attachReview(review);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentPanel.sidebar', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('agentPanel.open', () => provider.openAsEditor()),
    // Chat tabs come back after a reload, each with its own chat.
    vscode.window.registerWebviewPanelSerializer('agentPanel.chat', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        provider.adoptPanel(panel, String((state as { threadId?: string } | undefined)?.threadId ?? ''));
      },
    }),
    vscode.commands.registerCommand('agentPanel.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('agentPanel.addSelection', () => provider.addSelection()),
    vscode.commands.registerCommand('agentPanel.showLog', () => log?.show()),
    log,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, provider.baseContentProvider),
  );
}

export function deactivate(): void {
  /* processes end with the extension host */
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; mentions?: MentionItem[]; images?: ImageInput[] }
  | { type: 'restore'; messageId: string }
  | { type: 'unqueue'; index: number }
  | { type: 'sendNow'; index: number }
  | { type: 'switchTab'; id: string }
  | { type: 'openMention'; kind: string; id: string; label?: string }
  | { type: 'closeTab'; id: string }
  | { type: 'listExternal' }
  | { type: 'refreshUsage' }
  | { type: 'refreshModels' }
  | { type: 'openChat'; source: 'claude' | 'cursor'; id: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'loadThread'; id: string }
  | { type: 'deleteThread'; id: string }
  | { type: 'setEngine'; engine: EngineId }
  | { type: 'setModel'; engine: EngineId; model: string; effort?: string | null; fast?: boolean }
  | { type: 'setMode'; mode: AgentMode }
  | { type: 'setHandoff'; planner?: EngineId; builder?: EngineId; reviewAfter?: boolean }
  | { type: 'accept'; path: string }
  | { type: 'reject'; path: string }
  | { type: 'undo'; path: string }
  | { type: 'acceptAll' }
  | { type: 'rejectAll' }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openDiff'; path: string }
  | { type: 'permission'; id: string; decision: PermissionDecision }
  | { type: 'buildPlan'; messageId: string; text?: string }
  | { type: 'savePlan'; messageId: string; text: string }
  | { type: 'retry'; messageId: string; model?: string }
  | { type: 'getPatch'; key: string; path: string; base?: string; after?: string }
  | { type: 'searchMentions'; query: string; scope?: MentionScope; requestId: number }
  | { type: 'openExternal'; url: string }
  | { type: 'runInTerminal'; command: string };

interface Running {
  threadId: string;
  messageId: string;
  engine: EngineId;
  stop: () => void;
  answerPermission?: (id: string, d: PermissionDecision, input?: unknown) => void;
  stopRequested: boolean;
}

const PREFS_KEY = 'agentPanel.prefs';
const USAGE_KEY = 'agentPanel.usage';
const CATALOG_KEY = 'agentPanel.cursorCatalog';
const CLAUDE_INIT_KEY = 'agentPanel.claudeInit';
const SLASH_KEY = 'agentPanel.claudeSlashCommands';

class AgentPanelProvider implements vscode.WebviewViewProvider {
  /** Which chat each webview shows; editor tabs also keep their panel. */
  private bindings = new Map<vscode.Webview, { threadId: string; panel?: vscode.WebviewPanel; sidebar?: boolean }>();
  private thread: Thread;
  private tracker?: ChangeTracker;
  private gitOk = false;
  private gitMessage = '';
  private running?: Running;
  private permissionInput = new Map<string, unknown>();
  private cursorCatalog?: ModelCatalog;
  private claudeCatalog: ModelCatalog = claudeCatalog();
  private claudeInit?: ClaudeInit;
  /** True when Cursor's CLI answered with no models: it's signed out. */
  private cursorSignedOut = false;
  readonly baseContentProvider = new BaseContentProvider();
  private readonly store: ThreadStore;
  private readonly usage: UsageStore;
  private readonly mentions: MentionService;
  private review?: ReviewController;
  /** Messages sent while a turn runs; they go out in order when it ends (like Cursor). */
  private queue: { threadId: string; text: string; mentions: MentionItem[]; images: ImageInput[] }[] = [];
  /** Open chat tabs, live objects; `thread` is the visible one. */
  private tabs: Thread[] = [];
  private draining = false;
  private slash?: ReturnType<typeof slashItems>;
  private cursorSlash?: ReturnType<typeof cursorSlashItems>;
  /** Answers that ran a tool since their last text: the next text starts a new paragraph. */
  private breakAfterTool = new Set<string>();
  private cursorChats: ExternalChat[] = [];
  private watched?: string;
  private streamBuf = new Map<string, { text: string; thinking: string }>();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly claude: Engine,
    private readonly cursor: CursorEngine,
  ) {
    this.store = new ThreadStore(
      () => context.workspaceState.get<Thread[]>('threads'),
      (threads) => context.workspaceState.update('threads', threads),
    );
    this.usage = new UsageStore(
      () => context.globalState.get<UsageSnapshot>(USAGE_KEY),
      (s) => context.globalState.update(USAGE_KEY, s),
    );
    this.mentions = new MentionService(
      () => this.workspaceRoot(),
      () => this.store.list(),
      () => this.thread.id,
    );
    this.thread = createThread(this.prefs());
    this.tabs = [this.thread];
    void this.refreshWorkspace();
    // Last session's lists show at once; fresh ones replace them when they arrive.
    const cached = context.globalState.get<ModelCatalog>(CATALOG_KEY);
    if (cached && cached.source !== 'fallback') this.cursorCatalog = cached;
    this.claudeInit = context.globalState.get<ClaudeInit>(CLAUDE_INIT_KEY);
    if (this.claudeInit?.models?.length) this.claudeCatalog = claudeCatalogFromInit(this.claudeInit.models);
    void this.refreshCursorCatalog();
    void this.refreshClaudeCatalog();
    void this.refreshCursorAccount();
  }

  /**
   * Cursor's models as Cursor's own picker has them (its local catalog: names, settings,
   * descriptions, which models you switched on), limited to what the CLI can run. Falls
   * back to the CLI's flat list; a signed-out CLI's empty answer never replaces a real list.
   */
  private async refreshCursorCatalog(): Promise<void> {
    const [app, cli] = await Promise.all([readCursorAppCatalog().catch(() => undefined), this.cursor.catalog(true)]);
    this.cursorSignedOut = cli.source === 'fallback';
    const cliIds = cli.source === 'cli' ? new Set(cli.families.flatMap((f) => f.bases.flatMap((b) => b.variants.map((v) => v.id)))) : undefined;
    const next = cursorCatalogFromApp(app, cliIds) ?? (cli.source === 'cli' ? cli : undefined);
    if (next) {
      this.cursorCatalog = next;
      void this.context.globalState.update(CATALOG_KEY, next);
    }
    this.postState();
  }

  /** Claude's models, commands and plan, from the CLI itself (no model call). */
  private async refreshClaudeCatalog(): Promise<void> {
    const init = await describeClaude(vscode.workspace.getConfiguration('agentPanel').get<string>('claudePath')?.trim() || undefined, this.workspaceRoot()).catch(() => undefined);
    if (!init?.models.length) return;
    this.claudeInit = init;
    this.claudeCatalog = claudeCatalogFromInit(init.models);
    this.slash = undefined;
    void this.context.globalState.update(CLAUDE_INIT_KEY, init);
    if (init.account?.subscriptionType) this.usage.updateClaude({ plan: init.account.subscriptionType });
    this.postState();
  }

  /** Both Cursor accounts: the CLI's (used by the panel) and the app's. Checked fresh each time. */
  private async refreshCursorAccount(): Promise<void> {
    const [cli, app, signedIn] = await Promise.all([
      readCursorAccount(this.cursor.bin),
      readCursorAppAccount(),
      readCursorSignedIn(this.cursor.bin),
    ]);
    this.usage.updateCursor({ ...cli, ...app, signedIn });
    this.post({ type: 'usage', usage: this.usage.get() });
  }

  // ----- public surface for the review controller and commands -----

  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    this.configureWebview(webview, this.thread.id, undefined, true);
    view.onDidDispose(() => this.bindings.delete(webview));
  }

  async openAsEditor(): Promise<void> {
    this.openChatTab(this.thread);
  }

  /**
   * Each chat opens as its own editor tab, like Cursor's chat tabs: titled with the chat,
   * revealed if it's already open, restored after a reload.
   */
  openChatTab(t: Thread): void {
    this.activate(t);
    for (const b of this.bindings.values()) {
      if (b.panel && b.threadId === t.id) {
        b.panel.reveal(undefined, false);
        return;
      }
    }
    const panel = vscode.window.createWebviewPanel('agentPanel.chat', t.title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(join(this.context.extensionPath, 'dist'))],
    });
    this.adoptPanel(panel, t.id);
  }

  /** Wire an editor tab to its chat (new, or restored after a reload). */
  adoptPanel(panel: vscode.WebviewPanel, threadId: string): void {
    const t = this.threadById(threadId) ?? createThread(this.prefs());
    if (!this.tabs.some((x) => x.id === t.id)) this.tabs.push(t);
    panel.iconPath = {
      light: vscode.Uri.file(join(this.context.extensionPath, 'dist', 'icons', 'chat-light.svg')),
      dark: vscode.Uri.file(join(this.context.extensionPath, 'dist', 'icons', 'chat-dark.svg')),
    };
    // Keep the webview: `panel.webview` throws once the tab is closed.
    const webview = panel.webview;
    this.configureWebview(webview, t.id, panel);
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        const b = this.bindings.get(webview);
        const bound = b && this.threadById(b.threadId);
        if (bound) {
          this.thread = bound;
          this.watchSession();
        }
      }
    });
    panel.onDidDispose(() => {
      const b = this.bindings.get(webview);
      this.bindings.delete(webview);
      // The chat stays saved; a running one keeps going and shows in history.
      if (b && b.threadId !== this.running?.threadId && ![...this.bindings.values()].some((x) => x.threadId === b.threadId)) {
        this.tabs = this.tabs.filter((x) => x.id !== b.threadId);
      }
    });
    this.thread = t;
    this.postState();
  }

  attachReview(review: ReviewController): void {
    this.review = review;
  }

  getTracker(): ChangeTracker | undefined {
    return this.tracker;
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot();
  }

  postStatePublic(): void {
    this.postState();
  }

  newChat(): void {
    // Pending changes belong to the workspace, not the chat: the tracker stays.
    this.openChatTab(createThread(this.prefs()));
    this.prewarm();
    this.watchSession();
  }

  /** Editor selection → a chip in the composer (like Cursor's Cmd+L). */
  async addSelection(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) return;
    const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
    const a = ed.selection.start.line + 1;
    const b = ed.selection.end.line + 1;
    // Into the chat you're in: its tab if one is open, else the sidebar.
    const tab = [...this.bindings.values()].find((b) => b.threadId === this.thread.id && b.panel);
    if (tab?.panel) tab.panel.reveal(undefined, false);
    else await vscode.commands.executeCommand('agentPanel.sidebar.focus');
    this.post({
      threadId: this.thread.id,
      type: 'addMention',
      item: { kind: 'selection', id: `${rel}:${a}-${b}`, label: `${rel.split('/').pop()} ${a === b ? a : `${a}–${b}`}`, detail: rel, icon: 'selection' },
    });
  }

  /** Show a chat, opening a tab for it when it has none. */
  private activate(t: Thread): void {
    const i = this.tabs.findIndex((x) => x.id === t.id);
    if (i >= 0) t = this.tabs[i];
    else this.tabs.push(t);
    this.thread = t;
  }

  private closeTab(id: string): void {
    if (id === this.running?.threadId) {
      this.notice('That tab is running a turn. Stop it first.');
      return;
    }
    const i = this.tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    if (this.thread.id === id) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.thread = next;
      else this.activate(createThread(this.prefs()));
    }
    this.postState();
    this.watchSession();
  }

  // ----- preferences -----

  private prefs(): ThreadDefaults {
    const saved = this.context.globalState.get<Partial<ThreadDefaults>>(PREFS_KEY) ?? {};
    return {
      engine: saved.engine ?? 'claude',
      mode: saved.mode ?? 'agent',
      claudeModel: saved.claudeModel && claudeIds(this.claudeCatalog).includes(saved.claudeModel) ? saved.claudeModel : 'default',
      claudeEffort: saved.claudeEffort,
      claudeFast: saved.claudeFast,
      cursorModel: saved.cursorModel ?? 'auto',
      planner: saved.planner ?? 'claude',
      builder: saved.builder ?? 'cursor',
      reviewAfter: saved.reviewAfter ?? true,
    };
  }

  private savePrefs(): void {
    const t = this.thread;
    void this.context.globalState.update(PREFS_KEY, {
      engine: t.engine,
      mode: t.mode,
      claudeModel: this.modelFor('claude'),
      claudeEffort: t.claudeEffort,
      claudeFast: t.claudeFast,
      cursorModel: this.modelFor('cursor'),
      planner: t.planner ?? 'claude',
      builder: t.builder ?? 'cursor',
      reviewAfter: t.reviewAfter ?? true,
    } satisfies ThreadDefaults);
  }

  private modelFor(engine: EngineId): string {
    const t = this.thread;
    if (engine === 'claude') {
      const m = t.claudeModel ?? (t.engine === 'claude' ? t.model : undefined);
      const ids = claudeIds(this.claudeCatalog);
      return m && ids.includes(m) ? m : ids.includes('default') ? 'default' : 'opus';
    }
    const m = t.cursorModel ?? (t.engine === 'cursor' ? t.model : undefined) ?? 'auto';
    if (!this.cursorCatalog) return m;
    // Older saves hold flat ids; they resolve to the same variant in the new list.
    const found = findVariant(this.cursorCatalog, m).variant;
    return found ? found.id : 'auto';
  }

  private modelLabel(engine: EngineId): string {
    return engine === 'claude'
      ? buttonLabel(this.claudeCatalog, this.modelFor('claude'), { effort: this.thread.claudeEffort, fast: this.thread.claudeFast })
      : buttonLabel(this.cursorCatalog, this.modelFor('cursor'));
  }

  // ----- webview plumbing -----

  private configureWebview(webview: vscode.Webview, threadId: string, panel?: vscode.WebviewPanel, sidebar = false): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(join(this.context.extensionPath, 'dist'))],
    };
    this.bindings.set(webview, { threadId, panel, sidebar });
    webview.html = this.html(webview);
    webview.onDidReceiveMessage((msg: WebviewMessage) => {
      // A message acts on the chat its webview shows.
      const b = this.bindings.get(webview);
      const t = b && this.threadById(b.threadId);
      if (t) this.thread = t;
      void this.onMessage(msg).catch((err) => {
        log?.error(`${msg.type}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        this.notice(err instanceof Error ? err.message : String(err), 'error');
      });
    });
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async refreshWorkspace(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      this.gitOk = false;
      this.gitMessage = 'Open a folder to use Agent Panel.';
      this.tracker = undefined;
      return;
    }
    try {
      await assertGitRepo(root);
      this.gitOk = true;
      this.gitMessage = '';
      this.tracker ??= new ChangeTracker(root);
    } catch {
      this.gitOk = false;
      this.gitMessage = "This folder isn't a git repository, so changes can't be tracked. Accept and Reject are off.";
      this.tracker = undefined;
    }
  }

  /** To the webviews showing that chat when the message names one, else to all. */
  private post(msg: unknown): void {
    const threadId = (msg as { threadId?: string }).threadId;
    for (const [webview, b] of this.bindings) {
      if (!threadId || b.threadId === threadId) void webview.postMessage(msg);
    }
  }

  private notice(text: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'notice', text, level });
  }

  /**
   * Every webview shows one chat: the sidebar, and each chat's editor tab. Each gets the
   * state of its own chat, and editor tabs carry the chat's title.
   */
  private postState(): void {
    const active = this.thread;
    try {
      for (const [webview, b] of [...this.bindings]) {
        const t = this.threadById(b.threadId);
        if (!t) continue;
        this.thread = t;
        try {
          void webview.postMessage(this.buildState());
          if (b.panel) {
            const title = t.title.length > 32 ? `${t.title.slice(0, 31)}…` : t.title;
            b.panel.title = t.id === this.running?.threadId ? `● ${title}` : title;
          }
        } catch (err) {
          // A closed tab must never stop the other tabs from getting their state.
          if (/disposed/i.test(String(err))) this.bindings.delete(webview);
          else throw err;
        }
      }
    } finally {
      this.thread = active;
    }
  }

  private threadById(id: string): Thread | undefined {
    return this.tabs.find((t) => t.id === id) ?? (this.thread.id === id ? this.thread : undefined) ?? this.store.get(id);
  }

  /** The state message for one chat (the current `this.thread`). */
  private buildState(): Record<string, unknown> {

    const tracker = this.tracker;
    const fileStates: Record<string, string> = {};
    for (const m of this.thread.messages) {
      for (const f of m.files ?? []) {
        const s = tracker?.stateOf(f.relPath);
        if (s) fileStates[f.relPath] = s;
      }
    }
    return {
      type: 'state',
      thread: this.thread,
      threads: this.store.list().map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        engines: enginesUsed(t),
        files: filesChanged(t),
        mode: t.mode,
      })),
      gitOk: this.gitOk,
      gitMessage: this.gitMessage,
      running: this.running ? { messageId: this.running.messageId, engine: this.running.engine, threadId: this.running.threadId } : null,
      tabs: this.tabs.map((t) => ({ id: t.id, title: t.title, running: t.id === this.running?.threadId, engine: t.engine })),
      pending: tracker?.getPending().map(({ relPath, additions, deletions, status }) => ({ relPath, additions, deletions, status })) ?? [],
      fileStates,
      usage: this.usage.get(),
      catalogs: { claude: this.claudeCatalog, cursor: this.cursorCatalog ?? null },
      cursorSignedOut: this.cursorSignedOut,
      slashCommands: this.context.globalState.get<string[]>(SLASH_KEY) ?? [],
      slashItems: this.thread.engine === 'cursor' ? (this.cursorSlash ??= cursorSlashItems(this.workspaceRoot())) : this.slash ??= this.claudeInit?.commands?.length
        ? this.claudeInit.commands.map((c) => ({ name: c.name, description: c.description ?? '', kind: c.builtin ? ('command' as const) : ('skill' as const) }))
        : slashItems(this.workspaceRoot(), this.context.globalState.get<string[]>(SLASH_KEY) ?? []),
      queue: this.queue
        .map((q, index) => ({ index, threadId: q.threadId, text: q.text, attachments: q.mentions.length + q.images.length }))
        .filter((q) => q.threadId === this.thread.id),
      selection: {
        claudeModel: this.modelFor('claude'),
        claudeEffort: this.thread.claudeEffort ?? null,
        claudeFast: Boolean(this.thread.claudeFast),
        cursorModel: this.modelFor('cursor'),
      },
    };
  }

  private queueStream(id: string, kind: 'text' | 'thinking', delta: string): void {
    const buf = this.streamBuf.get(id) ?? { text: '', thinking: '' };
    buf[kind] += delta;
    this.streamBuf.set(id, buf);
    if (this.streamTimer) return;
    // Coalesce token spam into about 30 posts a second.
    this.streamTimer = setTimeout(() => this.flushStream(), 32);
  }

  private flushStream(): void {
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = undefined;
    }
    for (const [id, chunk] of this.streamBuf) {
      if (chunk.thinking) this.post({ type: 'thinking', id, delta: chunk.thinking });
      if (chunk.text) this.post({ type: 'text', id, delta: chunk.text });
    }
    this.streamBuf.clear();
  }

  // ----- messages from the webview -----

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.refreshWorkspace();
        this.postState();
        this.prewarm();
        this.mentions.warm();
        break;
      case 'send':
        if (this.running || this.draining) {
          this.queue.push({ threadId: this.thread.id, text: msg.text, mentions: msg.mentions ?? [], images: msg.images ?? [] });
          this.postState();
          break;
        }
        await this.handleSend(this.thread, msg.text, msg.mentions ?? [], msg.images ?? []);
        await this.drainQueue();
        break;
      case 'refreshUsage':
        await this.refreshCursorAccount();
        if (this.cursorSignedOut || !this.cursorCatalog) await this.refreshCursorCatalog();
        break;
      case 'refreshModels':
        await Promise.all([this.refreshCursorCatalog(), this.refreshClaudeCatalog()]);
        break;
      case 'listExternal':
        await this.listExternal();
        break;
      case 'openChat':
        await this.openChat(msg.source, msg.id);
        break;
      case 'openMention':
        await this.openMention(msg.kind, msg.id, msg.label ?? msg.id);
        break;
      case 'switchTab': {
        const t = this.tabs.find((x) => x.id === msg.id);
        if (t) {
          this.thread = t;
          this.postState();
          this.watchSession();
        }
        break;
      }
      case 'closeTab':
        this.closeTab(msg.id);
        break;
      case 'unqueue':
        this.queue.splice(msg.index, 1);
        this.postState();
        break;
      case 'sendNow': {
        // Run this one next: stop the turn in flight (its work so far is kept), and the queue starts here.
        const [item] = this.queue.splice(msg.index, 1);
        if (!item) break;
        this.queue.unshift(item);
        if (this.running) {
          this.running.stopRequested = true;
          this.running.stop();
          this.postState();
        } else {
          await this.drainQueue();
        }
        break;
      }
      case 'restore':
        await this.restoreCheckpoint(msg.messageId);
        break;
      case 'stop':
        if (this.running) {
          this.running.stopRequested = true;
          this.running.stop();
        }
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'loadThread': {
        const t = this.tabs.find((x) => x.id === msg.id) ?? this.store.get(msg.id);
        if (t) {
          this.openChatTab(t);
          this.postState();
          this.prewarm();
          this.watchSession();
        }
        break;
      }
      case 'deleteThread':
        await this.store.remove(msg.id);
        for (const b of [...this.bindings.values()]) if (b.panel && b.threadId === msg.id && msg.id !== this.running?.threadId) b.panel.dispose();
        this.tabs = this.tabs.filter((x) => x.id !== msg.id || x.id === this.running?.threadId);
        if (msg.id === this.thread.id && msg.id !== this.running?.threadId) this.activate(createThread(this.prefs()));
        this.postState();
        break;
      case 'setEngine':
        this.thread.engine = msg.engine;
        this.thread.model = this.modelFor(msg.engine);
        this.savePrefs();
        this.postState();
        break;
      case 'setModel':
        if (msg.engine === 'claude') {
          if (claudeIds(this.claudeCatalog).includes(msg.model)) this.thread.claudeModel = msg.model;
          if (msg.effort !== undefined) this.thread.claudeEffort = msg.effort ?? undefined;
          if (msg.fast !== undefined) this.thread.claudeFast = msg.fast;
        } else {
          this.thread.cursorModel = msg.model;
        }
        this.thread.model = this.modelFor(this.thread.engine);
        this.savePrefs();
        this.postState();
        if (msg.engine === 'claude') this.prewarm();
        break;
      case 'setMode':
        this.thread.mode = msg.mode;
        this.savePrefs();
        this.postState();
        break;
      case 'setHandoff':
        if (msg.planner) this.thread.planner = msg.planner;
        if (msg.builder) this.thread.builder = msg.builder;
        if (msg.reviewAfter !== undefined) this.thread.reviewAfter = msg.reviewAfter;
        this.savePrefs();
        this.postState();
        break;
      case 'accept':
        this.tracker?.accept(msg.path);
        await this.afterResolve();
        break;
      case 'reject':
        await this.tracker?.reject(msg.path);
        await this.afterResolve();
        break;
      case 'undo':
        await this.tracker?.undo(msg.path);
        await this.afterResolve();
        break;
      case 'acceptAll':
        this.tracker?.acceptAll();
        await this.afterResolve();
        break;
      case 'rejectAll':
        await this.tracker?.rejectAll();
        await this.afterResolve();
        break;
      case 'openFile':
        await this.openFile(msg.path, msg.line);
        break;
      case 'openDiff':
        if (this.review && this.tracker?.stateOf(msg.path) === 'pending') await this.review.openDiff(msg.path);
        else await this.openDiff(msg.path);
        break;
      case 'permission':
        this.answerPermission(msg.id, msg.decision);
        break;
      case 'savePlan':
        this.updatePlanText(msg.messageId, msg.text);
        break;
      case 'buildPlan':
        if (msg.text !== undefined) this.updatePlanText(msg.messageId, msg.text);
        await this.runBuild(msg.messageId);
        await this.drainQueue();
        break;
      case 'retry':
        await this.retry(msg.messageId, msg.model);
        await this.drainQueue();
        break;
      case 'getPatch':
        await this.sendPatch(msg.key, msg.path, msg.base, msg.after);
        break;
      case 'searchMentions': {
        const groups = await this.mentions.search(msg.query, msg.scope);
        this.post({ type: 'mentions', requestId: msg.requestId, groups });
        break;
      }
      case 'openExternal':
        if (/^https:\/\//.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'runInTerminal':
        if (['claude', 'agent login', 'agent relogin'].includes(msg.command)) {
          const term = vscode.window.createTerminal({ name: 'Agent Panel sign-in', cwd: this.workspaceRoot() });
          term.show();
          const bin = JSON.stringify(this.cursor.bin);
          term.sendText(
            msg.command === 'agent login' ? `${bin} login` : msg.command === 'agent relogin' ? `${bin} logout && ${bin} login` : 'claude',
          );
        }
        break;
      default:
        break;
    }
  }

  private async afterResolve(): Promise<void> {
    await this.review?.refresh();
    this.postState();
  }

  private async openFile(relPath: string, line?: number): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    if (line === undefined && this.review && this.tracker?.stateOf(relPath) === 'pending') {
      await this.review.openFile(relPath, { revealFirst: true });
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, relPath)));
    const ed = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.max(0, line), 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async sendPatch(key: string, path: string, base?: string, after?: string): Promise<void> {
    let patch = '';
    try {
      if (this.tracker && base && after) patch = await this.tracker.patchBetween(base, after, path);
      else if (this.tracker) patch = await this.tracker.patchFor(path);
    } catch {
      patch = '';
    }
    this.post({ type: 'patch', key, patch });
  }

  private prewarm(): void {
    const root = this.workspaceRoot();
    if (!root || this.running) return;
    const engineInUse = this.thread.engine === 'claude' || this.thread.mode === 'handoff';
    if (engineInUse) {
      this.claude.prewarm?.(root, this.modelFor('claude'), this.thread.claudeEffort, this.thread.claudeSessionId, this.thread.claudeFast, this.thread.id);
    }
  }

  // ----- turns -----

  /** Claude Code sessions and Cursor chats for this workspace, for the history view. */
  private async listExternal(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const claude = await listClaudeSessions(root).catch(() => []);
    // Cursor's list costs a few seconds on a large state database: send what we have, then refresh.
    this.post({ type: 'external', claude, cursor: this.cursorChats, loadingCursor: true });
    this.cursorChats = await listCursorChats(root).catch(() => this.cursorChats);
    this.post({ type: 'external', claude, cursor: this.cursorChats, loadingCursor: false });
  }

  /**
   * Open a chat made outside the panel. A Claude Code session is continued under its own
   * session id, so the official extension sees the new turns too. A Cursor chat is read
   * from Cursor's database and its history goes to whichever engine answers next.
   */
  private async openChat(source: 'claude' | 'cursor', id: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const known = this.store.list().find((t) => (source === 'claude' ? t.claudeSessionId === id : t.source?.kind === 'cursor' && t.source.id === id));
    if (known && !(source === 'claude' && known.source?.kind === 'claude')) {
      this.openChatTab(this.tabs.find((x) => x.id === known.id) ?? known);
    } else {
      const messages = source === 'claude' ? await loadClaudeSession(root, id) : await loadCursorChat(id);
      if (!messages.length) {
        this.notice("That chat couldn't be read, or it has no messages yet.", 'error');
        return;
      }
      const list = source === 'claude' ? await listClaudeSessions(root).catch(() => []) : this.cursorChats;
      const t = known ?? createThread({ ...this.prefs(), engine: source });
      t.title = list.find((c) => c.id === id)?.title ?? titleFromPrompt(messages.find((m) => m.role === 'user')?.text ?? 'Imported chat');
      t.messages = messages;
      t.engine = source;
      t.source = { kind: source, id, syncedAt: Date.now() };
      t.lastEngine = source;
      if (source === 'claude') {
        t.claudeSessionId = id;
        t.claudeSeen = messages.length;
      }
      t.updatedAt = Math.max(...messages.map((m) => m.createdAt));
      this.openChatTab(t);
      await this.store.save(t);
    }
    this.postState();
    this.watchSession();
    this.prewarm();
  }

  /** Follow the open thread's Claude session file: turns added in Claude Code show up here. */
  private watchSession(): void {
    const root = this.workspaceRoot();
    if (this.watched) unwatchFile(this.watched);
    this.watched = undefined;
    const id = this.thread.claudeSessionId;
    if (!root || !id) return;
    const file = join(claudeProjectDir(root), `${id}.jsonl`);
    if (!existsSync(file)) return;
    this.watched = file;
    const threadId = this.thread.id;
    watchFile(file, { interval: 1500 }, () => {
      if (this.running || this.draining || this.thread.id !== threadId) return;
      void (async () => {
        const messages = await loadClaudeSession(root, id);
        const t = this.thread;
        const seen = t.claudeSeen ?? messages.length;
        if (messages.length <= seen) return;
        // Turns added in Claude Code (the official extension or the CLI) since the panel last looked.
        t.messages.push(...messages.slice(seen));
        t.claudeSeen = messages.length;
        t.updatedAt = Date.now();
        await this.store.save(t);
        this.postState();
      })();
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.running) {
        const next = this.queue.shift()!;
        const t = this.tabs.find((x) => x.id === next.threadId) ?? this.store.get(next.threadId);
        if (!t) continue;
        this.postState();
        await this.handleSend(t, next.text, next.mentions, next.images);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Put files back to how they were before a user message, like Cursor's checkpoints:
   * every file changed by that turn or a later one returns to the first turn's base.
   * The chat itself is kept.
   */
  private async restoreCheckpoint(userMessageId: string): Promise<void> {
    if (this.running || !this.tracker) return;
    const idx = this.thread.messages.findIndex((m) => m.id === userMessageId);
    if (idx < 0) return;
    const later = this.thread.messages.slice(idx + 1).filter((m) => m.role === 'assistant' && m.trees && m.files?.length);
    if (!later.length) {
      this.notice('Nothing changed after this message.');
      return;
    }
    const paths = [...new Set(later.flatMap((m) => m.files!.map((f) => f.relPath)))];
    await this.tracker.restore(later[0].trees!.base, paths);
    this.pushNote(`Restored ${paths.length} file${paths.length === 1 ? '' : 's'} to before this message`, 'history');
    await this.store.save(this.thread);
    await this.review?.refresh();
    this.postState();
  }

  /** Open something attached with @: the file, the folder, the diff, the panel or the chat. */
  private async openMention(kind: string, id: string, label: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) return;
    const run = promisify(execFile);
    const showText = async (content: string, language: string) => {
      const doc = await vscode.workspace.openTextDocument({ content, language });
      await vscode.window.showTextDocument(doc, { preview: true });
    };
    try {
      switch (kind) {
        case 'file':
        case 'rule':
          await this.openFile(id);
          break;
        case 'folder':
          await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(join(root, id)));
          break;
        case 'symbol': {
          const i = id.lastIndexOf(':');
          await this.openFile(id.slice(0, i), Number(id.slice(i + 1)) || 0);
          break;
        }
        case 'selection': {
          const m = /^(.*):(\d+)-(\d+)$/.exec(id);
          if (!m) break;
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root, m[1])));
          const ed = await vscode.window.showTextDocument(doc, { preview: true });
          const range = new vscode.Range(Number(m[2]) - 1, 0, Number(m[3]) - 1, doc.lineAt(Math.min(doc.lineCount - 1, Number(m[3]) - 1)).text.length);
          ed.selection = new vscode.Selection(range.start, range.end);
          ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
          break;
        }
        case 'git-diff':
          await showText((await run('git', ['diff', 'HEAD'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout || '(no uncommitted changes)', 'diff');
          break;
        case 'commit':
          await showText((await run('git', ['show', '--stat', '--patch', id], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout, 'diff');
          break;
        case 'branch': {
          const base = await defaultBranch(root);
          await showText((await run('git', ['diff', `${base}...HEAD`], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout || `(no changes against ${base})`, 'diff');
          break;
        }
        case 'problems':
          await vscode.commands.executeCommand('workbench.actions.view.problems');
          break;
        case 'chat': {
          const t = this.tabs.find((x) => x.id === id) ?? this.store.get(id);
          if (t) {
            this.activate(t);
            this.postState();
          }
          break;
        }
        case 'image':
          if (existsSync(id)) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(id));
          else this.notice(`${label} was sent before images were saved, so there's nothing to open.`);
          break;
        default:
          break;
      }
    } catch (err) {
      this.notice(`Couldn't open ${label}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  /** Keep sent images, so a chip in the chat can open them later. */
  private saveImages(images: ImageInput[]): string[] {
    const dir = join(this.context.globalStorageUri.fsPath, 'images');
    mkdirSync(dir, { recursive: true });
    return images.map((img, i) => {
      const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
      const file = join(dir, `${Date.now()}-${i}.${ext}`);
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
  }

  /** Cursor's CLI takes text only: pasted images go to temp files it can read. */
  private imagesAsFiles(images: ImageInput[]): string {
    if (!images.length) return '';
    const dir = join(tmpdir(), 'agent-panel-images');
    mkdirSync(dir, { recursive: true });
    const paths = images.map((img, i) => {
      const ext = img.mediaType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const file = join(dir, `${Date.now()}-${i}.${ext}`);
      writeFileSync(file, Buffer.from(img.data, 'base64'));
      return file;
    });
    return `The user attached ${paths.length === 1 ? 'an image' : 'images'}. Read ${paths.length === 1 ? 'it' : 'them'} to see:\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`;
  }

  private async handleSend(t: Thread, text: string, mentions: MentionItem[], images: ImageInput[] = []): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.running) return;
    if (!this.workspaceRoot()) {
      this.notice('Open a folder first.', 'error');
      return;
    }
    if (!this.tracker) await this.refreshWorkspace();
    const context = await this.mentions.resolve(mentions);
    const refs = [
      ...mentions.map(({ kind, id, label, detail }) => ({ kind, id, label, detail })),
      ...this.saveImages(images).map((file, i) => ({ kind: 'image', id: file, label: images[i].name })),
    ];
    // Slash commands go to Claude untouched, so the CLI runs them.
    if (prompt.startsWith('/') && t.engine === 'claude' && t.mode !== 'handoff') {
      await this.runTurn('claude', prompt, turnModeOf(t.mode), { userText: prompt, thread: t });
      return;
    }

    if (t.mode === 'handoff') {
      await this.runPlan(t, prompt, context, refs);
      return;
    }
    const mode = turnModeOf(t.mode);
    // Cursor: `/skill` or `/command` becomes the instruction it stands for.
    const sent = t.engine === 'cursor' && prompt.startsWith('/') ? expandForCursor(prompt, (this.cursorSlash ??= cursorSlashItems(this.workspaceRoot()))) : prompt;
    const imageNote = t.engine === 'cursor' ? this.imagesAsFiles(images) : '';
    await this.runTurn(t.engine, `${imageNote}${context}${sent}`, mode, {
      userText: prompt,
      mentions: refs,
      images: t.engine === 'claude' ? images : undefined,
      thread: t,
    });
  }

  private async retry(assistantId: string, model?: string): Promise<void> {
    const idx = this.thread.messages.findIndex((m) => m.id === assistantId);
    const failed = this.thread.messages[idx];
    if (idx < 0 || !failed?.engine || this.running) return;
    if (model) {
      if (failed.engine === 'cursor') this.thread.cursorModel = model;
      else this.thread.claudeModel = model;
      this.savePrefs();
    }
    let user: ChatMessage | undefined;
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (this.thread.messages[i].role === 'user') {
        user = this.thread.messages[i];
        break;
      }
    }
    if (!user) return;
    // The failed turn is replaced by the new attempt.
    this.thread.messages.splice(idx, 1);
    const mode = failed.meta?.mode ?? 'agent';
    await this.runTurn(failed.engine, user.text, mode, { reuseUser: true });
  }

  private async runPlan(t: Thread, request: string, context: string, mentions: ChatMessage['mentions']): Promise<void> {
    const planner = t.planner ?? 'claude';
    const builder = t.builder ?? 'cursor';
    await this.runTurn(planner, `${context}${planPrompt(request)}`, 'plan', {
      thread: t,
      userText: request,
      mentions,
      role: 'planner',
      plan: { request, planner, builder, reviewAfter: t.reviewAfter ?? true, state: 'ready' },
    });
  }

  private updatePlanText(messageId: string, text: string): void {
    const m = this.thread.messages.find((x) => x.id === messageId);
    if (m?.plan) {
      m.text = text;
      void this.store.save(this.thread);
      this.postState();
    }
  }

  private async runBuild(planMessageId: string): Promise<void> {
    const thread = this.thread;
    const planMsg = thread.messages.find((x) => x.id === planMessageId);
    const plan = planMsg?.plan;
    if (!planMsg || !plan || plan.state !== 'ready' || this.running) return;
    plan.state = 'building';
    this.pushNote(`Plan and request passed to ${engineName(plan.builder)}`, 'arrow-right', thread);
    const built = await this.runTurn(plan.builder, buildPrompt(plan.request, planMsg.text), 'agent', {
      thread,
      hiddenUser: true,
      role: 'builder',
    });
    plan.state = 'built';
    this.postState();
    if (built.ok && plan.reviewAfter) {
      const files = (built.message.files ?? []).map((f) => f.relPath);
      this.pushNote(`Diff sent back to ${engineName(plan.planner)} for review, read-only`, 'arrow-left', thread);
      await this.runTurn(plan.planner, reviewPrompt(plan.request, planMsg.text, files), 'plan', {
        thread,
        hiddenUser: true,
        role: 'reviewer',
      });
    }
    await this.store.save(thread);
    this.postState();
  }

  private pushNote(text: string, icon: string, thread: Thread = this.thread): void {
    const note: ChatMessage = { id: newId('n'), role: 'system', text, icon, createdAt: Date.now() };
    thread.messages.push(note);
    this.post({ type: 'message', message: note, threadId: thread.id });
  }

  private answerPermission(id: string, decision: PermissionDecision): void {
    const run = this.running;
    if (!run) return;
    run.answerPermission?.(id, decision, this.permissionInput.get(id));
    this.permissionInput.delete(id);
    const owner = this.tabs.find((t) => t.id === run.threadId) ?? this.thread;
    const msg = owner.messages.find((m) => m.id === run.messageId);
    const step = msg?.steps?.find((s) => s.ask?.id === id || s.id === id);
    if (step) {
      step.status = decision === 'deny' ? 'denied' : 'running';
      step.ask = undefined;
      this.post({ type: 'step', messageId: run.messageId, step });
    }
  }

  private async runTurn(
    engineId: EngineId,
    prompt: string,
    mode: 'agent' | 'auto' | 'ask' | 'plan',
    opts: {
      thread?: Thread;
      images?: ImageInput[];
      userText?: string;
      mentions?: ChatMessage['mentions'];
      hiddenUser?: boolean;
      reuseUser?: boolean;
      role?: TurnMeta['role'];
      plan?: ChatMessage['plan'];
    } = {},
  ): Promise<{ ok: boolean; text: string; message: ChatMessage }> {
    const root = this.workspaceRoot()!;
    const thread = opts.thread ?? this.thread;

    // Switching engines: say so in the thread and pass the other engine's context on.
    let finalPrompt = prompt;
    if (thread.source?.kind === 'cursor' && !(thread.transcriptSentTo ?? []).includes(engineId)) {
      // A chat imported from Cursor's panel: neither CLI has seen it, so send it once.
      finalPrompt = `${transcript(thread.messages)}${prompt}`;
      thread.transcriptSentTo = [...(thread.transcriptSentTo ?? []), engineId];
    } else if (thread.lastEngine && thread.lastEngine !== engineId) {
      const pendingFiles = this.tracker?.getPending() ?? [];
      // The other engine's unreviewed changes, as a diff, so the work carries over exactly.
      let pendingDiff = '';
      for (const f of pendingFiles.slice(0, 20)) {
        if (pendingDiff.length > 12_000) break;
        pendingDiff += await this.tracker!.patchFor(f.relPath).catch(() => '');
      }
      const prefix = buildHandoverPrefix(thread, engineId, pendingFiles, pendingDiff);
      finalPrompt = `${prefix}${prompt}`;
      if (!opts.role) {
        const passed = countPassed(thread, engineId);
        this.pushNote(
          `Switched to ${engineName(engineId)} · ${passed.messages} message${passed.messages === 1 ? '' : 's'}${
            passed.files ? ` and ${passed.files} changed file${passed.files === 1 ? '' : 's'}` : ''
          } passed on`,
          'arrow-swap',
          thread,
        );
      }
    }

    if (!opts.hiddenUser && !opts.reuseUser) {
      const userMsg: ChatMessage = {
        id: newId('u'),
        role: 'user',
        engine: engineId,
        text: opts.userText ?? prompt,
        mentions: opts.mentions?.length ? opts.mentions : undefined,
        createdAt: Date.now(),
      };
      thread.messages.push(userMsg);
      if (thread.title === 'New chat') thread.title = titleFromPrompt(userMsg.text);
      this.post({ type: 'message', message: userMsg, threadId: thread.id });
    }

    const meta: TurnMeta = {
      model: this.modelFor(engineId),
      modelLabel: this.modelLabel(engineId),
      effort: engineId === 'claude' ? thread.claudeEffort : undefined,
      mode,
      role: opts.role,
    };
    const assistant: ChatMessage = {
      id: newId('a'),
      role: 'assistant',
      engine: engineId,
      text: '',
      thinking: '',
      steps: [],
      parts: [],
      meta,
      plan: opts.plan,
      createdAt: Date.now(),
    };
    thread.messages.push(assistant);
    thread.updatedAt = Date.now();
    void this.store.save(thread);
    this.post({ type: 'message', message: assistant, threadId: thread.id });

    // Snapshot before the turn so a warm Claude process cannot edit ahead of the base tree.
    let baseTree: string | undefined;
    if (this.tracker && this.gitOk) {
      try {
        baseTree = await this.tracker.snapshotTree();
      } catch (err) {
        this.notice(err instanceof Error ? err.message : String(err), 'error');
      }
    }

    const engine = engineId === 'claude' ? this.claude : this.cursor;
    const started = Date.now();
    log?.info(`turn start · ${engineId} · ${meta.model}${meta.effort ? `/${meta.effort}` : ''} · ${mode} · chat ${thread.id}${finalPrompt !== prompt ? ' · with hand-over' : ''}`);
    let ok = false;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.flushStream();
        resolve();
      };
      const onEvent = (event: AgentEvent) => this.onEngineEvent(thread, assistant, event, (done) => {
        ok = done;
        finish();
      });
      const handle = engine.startTurn({
        workspaceRoot: root,
        model: meta.model!,
        effort: meta.effort,
        fast: engineId === 'claude' ? Boolean(thread.claudeFast) : undefined,
        mode,
        prompt: finalPrompt,
        images: opts.images,
        sessionId: engineId === 'claude' ? thread.claudeSessionId : thread.cursorSessionId,
        chatId: thread.id,
        onEvent,
      });
      this.running = { threadId: thread.id, messageId: assistant.id, engine: engineId, stopRequested: false, ...bindHandle(handle) };
      this.post({ type: 'running', running: { messageId: assistant.id, engine: engineId, threadId: thread.id } });
      setTimeout(() => {
        if (!settled) {
          handle.stop();
          meta.error = 'Stopped after 30 minutes with no end.';
          finish();
        }
      }, 30 * 60 * 1000);
    });

    // The panel's own turn is in the session file now; don't import it back.
    if (engineId === 'claude' && thread.claudeSessionId) {
      thread.claudeSeen = (await loadClaudeSession(root, thread.claudeSessionId).catch(() => [])).length;
    }
    if (this.running?.stopRequested) {
      meta.stopped = true;
      meta.error = undefined;
      ok = false;
    }
    this.running = undefined;
    meta.durationMs ??= Date.now() - started;
    if (meta.error) log?.error(`turn failed · ${engineId} · ${meta.error}`);
    log?.info(`turn end · ${engineId} · ${meta.stopped ? 'stopped' : ok ? 'ok' : 'error'} · ${Math.round((Date.now() - started) / 1000)}s · ${assistant.steps?.length ?? 0} steps`);
    for (const s of assistant.steps ?? []) {
      if (s.status === 'running' || s.status === 'ask') s.status = meta.stopped ? 'denied' : 'ok';
      s.ask = undefined;
    }

    if (this.tracker && baseTree) {
      try {
        const diff = await this.tracker.captureTurn(baseTree);
        if (diff.turnFiles.length) {
          assistant.files = diff.turnFiles.map(({ relPath, additions, deletions, status }) => ({ relPath, additions, deletions, status }));
          assistant.trees = { base: diff.baseTree, after: diff.afterTree };
        }
      } catch (err) {
        this.notice(err instanceof Error ? err.message : String(err), 'error');
      }
    }

    thread.lastEngine = engineId;
    thread.updatedAt = Date.now();
    if (assistant.thinking && assistant.thinking.length > 20_000) assistant.thinking = `${assistant.thinking.slice(0, 20_000)}…`;
    await this.store.save(thread);
    this.post({ type: 'turn-done', message: assistant, threadId: thread.id });
    if (engineId === 'claude' && this.watched !== join(claudeProjectDir(root), `${thread.claudeSessionId}.jsonl`)) this.watchSession();
    this.postState();
    if (assistant.files?.length) {
      const openFirst = vscode.workspace.getConfiguration('agentPanel').get<boolean>('openEditsInEditor') === true;
      await this.review?.refresh({ openFirst });
    }
    return { ok, text: assistant.text, message: assistant };
  }

  private onEngineEvent(thread: Thread, assistant: ChatMessage, event: AgentEvent, done: (ok: boolean) => void): void {
    const meta = assistant.meta!;
    const parts = (assistant.parts ??= []);
    const last = parts[parts.length - 1];
    const now = Date.now();
    // Any non-thinking event ends a thinking stretch: that's its duration.
    if (event.kind !== 'thinking' && last?.kind === 'thinking' && !last.endedAt) last.endedAt = now;
    switch (event.kind) {
      case 'text': {
        let delta = event.delta;
        if (this.breakAfterTool.delete(assistant.id) && assistant.text && !/\n\s*$/.test(assistant.text) && !delta.startsWith('\n')) {
          delta = `\n\n${delta}`;
        }
        assistant.text += delta;
        if (last?.kind === 'text') last.text += delta;
        else parts.push({ kind: 'text', text: delta.replace(/^\n+/, '') });
        this.queueStream(assistant.id, 'text', delta);
        break;
      }
      case 'thinking':
        assistant.thinking = (assistant.thinking ?? '') + event.delta;
        if (last?.kind === 'thinking' && !last.endedAt) last.text += event.delta;
        else parts.push({ kind: 'thinking', text: event.delta, startedAt: now });
        this.queueStream(assistant.id, 'thinking', event.delta);
        break;
      case 'tool-start': {
        this.flushStream();
        this.breakAfterTool.add(assistant.id);
        const steps = (assistant.steps ??= []);
        const known = steps.find((s) => s.id === event.id);
        // The file the step touches and, for an edit, its own diff (read before the edit lands).
        const edit = event.input ? stepEdit(this.workspaceRoot() ?? '', event.tool, event.input) : undefined;
        if (known) {
          // Same tool again with its full input: better title, to-dos, file and diff.
          known.title = event.title;
          if (event.parentId) known.parentId = event.parentId;
          const agent = agentOf(event.tool, event.input);
          if (agent) known.agent = agent;
          const cmd = (event.input as { command?: unknown } | undefined)?.command;
          if (typeof cmd === 'string' && cmd) known.command = cmd;
          if (event.todos) known.todos = event.todos;
          if (edit) Object.assign(known, edit.diff === '' ? { path: edit.path } : edit);
          this.post({ type: 'step', messageId: assistant.id, step: known });
          break;
        }
        const cmd = (event.input as { command?: unknown } | undefined)?.command;
        const child = Boolean(event.parentId);
        const step: StepRecord = { id: event.id, tool: event.tool, title: event.title, status: 'running', todos: event.todos, parentId: event.parentId, agent: agentOf(event.tool, event.input), command: typeof cmd === 'string' && cmd ? cmd : undefined, ...edit };
        steps.push(step);
        // A subagent's own steps hang under its step; only top-level ones are in the timeline.
        if (!child) {
          if (last?.kind === 'steps') last.ids.push(step.id);
          else parts.push({ kind: 'steps', ids: [step.id] });
        }
        this.post({ type: 'step', messageId: assistant.id, step });
        break;
      }
      case 'tool-end': {
        const step = assistant.steps?.find((s) => s.id === event.id);
        if (!step) break;
        if (step.status !== 'denied') step.status = event.ok ? 'ok' : 'fail';
        // One-word results ("text", "update") say nothing a person needs.
        step.summary = /^\s*(text|update|create|ok|success|edit|write)\s*$/i.test(event.summary ?? '') ? undefined : event.summary?.slice(0, 4000);
        if (event.output && step.agent) event.output = subagentReport(event.output);
        if (event.output) step.output =event.output.length > 40_000 ? `${event.output.slice(0, 40_000)}\n… output cut at 40,000 characters` : event.output;
        if (event.diff && !step.diff) {
          step.diff = event.diff.slice(0, 60_000);
          step.additions = event.additions;
          step.deletions = event.deletions;
        }
        step.ask = undefined;
        this.post({ type: 'step', messageId: assistant.id, step });
        break;
      }
      case 'permission': {
        this.flushStream();
        this.permissionInput.set(event.id, event.input);
        const steps = (assistant.steps ??= []);
        const input = (event.input ?? {}) as Record<string, unknown>;
        const who = engineName(assistant.engine ?? 'claude');
        const command = typeof input.command === 'string' ? input.command : undefined;
        const file = (typeof input.file_path === 'string' && input.file_path) || (typeof input.path === 'string' && input.path) || undefined;
        const ask = command
          ? { id: event.id, title: `${who} wants to run a command`, detail: command }
          : file
            ? { id: event.id, title: `${who} wants to change a file`, detail: vscode.workspace.asRelativePath(file, false) }
            : { id: event.id, title: `${who} wants to use ${event.tool}` };
        // The permission belongs to the tool step that triggered it when there is one.
        const existing = event.toolUseId ? steps.find((s) => s.id === event.toolUseId) : undefined;
        const step: StepRecord = existing ?? { id: event.id, tool: event.tool, title: event.title, status: 'ask' };
        step.status = 'ask';
        step.ask = ask;
        if (!existing) {
          steps.push(step);
          if (last?.kind === 'steps') last.ids.push(step.id);
          else parts.push({ kind: 'steps', ids: [step.id] });
        }
        this.post({ type: 'step', messageId: assistant.id, step });
        break;
      }
      case 'usage':
        this.usage.updateClaude({
          fiveHour: event.fiveHour,
          fiveHourResetsAt: event.fiveHourResetsAt,
          sevenDay: event.sevenDay,
          sevenDayResetsAt: event.sevenDayResetsAt,
          status: event.status,
        });
        this.post({ type: 'usage', usage: this.usage.get() });
        break;
      case 'session':
        if (event.slashCommands?.length) {
          void this.context.globalState.update(SLASH_KEY, event.slashCommands);
          this.slash = undefined;
        }
        if (event.engine === 'claude') thread.claudeSessionId = event.sessionId;
        else thread.cursorSessionId = event.sessionId;
        break;
      case 'done':
        meta.durationMs = event.durationMs;
        meta.usage = { ...event.usage, costUsd: event.costUsd ?? event.usage?.costUsd };
        if (!event.ok && !this.running?.stopRequested) meta.error = event.error ?? 'The turn ended with an error.';
        done(event.ok);
        break;
      default:
        break;
    }
  }

  private async openDiff(relPath: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root || !this.tracker) return;
    const base = await this.tracker.baseContent(relPath);
    this.baseContentProvider.set(relPath, base ?? '');
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.parse(`${BASE_SCHEME}:${relPath}`),
      vscode.Uri.file(join(root, relPath)),
      `${relPath} (before ↔ now)`,
    );
  }

  private html(webview: vscode.Webview): string {
    const dist = join(this.context.extensionPath, 'dist');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.file(join(dist, f)));
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${csp} https: data:; style-src ${csp} 'unsafe-inline'; script-src ${csp}; font-src ${csp};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${uri('codicons/codicon.css')}" rel="stylesheet" />
  <link href="${uri('webview.css')}" rel="stylesheet" />
  <title>Agent Panel</title>
</head>
<body>
  <div id="app"></div>
  <script src="${uri('webview.js')}"></script>
</body>
</html>`;
  }
}

function bindHandle(handle: ReturnType<Engine['startTurn']>): Pick<Running, 'stop' | 'answerPermission'> {
  return {
    stop: () => handle.stop(),
    answerPermission: handle.answerPermission?.bind(handle),
  };
}

function engineName(e: EngineId): string {
  return e === 'claude' ? 'Claude' : 'Cursor';
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** What a hand-over passes on: messages since that engine last answered, and files they changed. */
function countPassed(thread: Thread, next: EngineId): { messages: number; files: number } {
  let last = -1;
  thread.messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.engine === next) last = i;
  });
  const slice = thread.messages.slice(last + 1).filter((m) => m.role !== 'system');
  const files = new Set<string>();
  for (const m of slice) for (const f of m.files ?? []) files.add(f.relPath);
  return { messages: slice.length, files: files.size };
}

class BaseContentProvider implements vscode.TextDocumentContentProvider {
  private content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(path: string, text: string): void {
    this.content.set(path, text);
    this.emitter.fire(vscode.Uri.parse(`${BASE_SCHEME}:${path}`));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.path.replace(/^\//, '');
    return this.content.get(key) ?? this.content.get(uri.fsPath) ?? this.content.get(uri.path) ?? '';
  }
}

/** A chat's mode as a turn's mode (hand-off turns pick their own). */
function turnModeOf(mode: string): 'agent' | 'auto' | 'ask' | 'plan' {
  return mode === 'plan' || mode === 'ask' || mode === 'auto' ? mode : 'agent';
}

/** A subagent's identity from its tool call (Claude's Agent or Task tool). */
function agentOf(tool: string, input: unknown): StepRecord['agent'] {
  if (tool !== 'Agent' && tool !== 'Task') return undefined;
  const o = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return { type: text(o.subagent_type), description: text(o.description), prompt: text(o.prompt) };
}
