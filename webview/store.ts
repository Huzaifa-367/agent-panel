import type { ChatMessage, StepRecord, Thread, TurnFile } from '../src/threads';
import type { ModelCatalog } from '../src/models';
import type { UsageSnapshot } from '../src/usage';
import type { MentionGroup, MentionItem, MentionScope } from '../src/mentions';

export type { ChatMessage, StepRecord, Thread, TurnFile, ModelCatalog, UsageSnapshot, MentionGroup, MentionItem, MentionScope };

export type EngineId = 'claude' | 'cursor';

export interface PendingFile extends TurnFile {}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  engines: EngineId[];
  files: number;
  mode: string;
}

/** Everything the host sends in a `state` message. */
export interface HostState {
  thread: Thread;
  threads: ThreadSummary[];
  gitOk: boolean;
  gitMessage: string;
  running: { messageId: string; engine: EngineId; threadId?: string } | null;
  /** Show the tab strip in the header (chats live in this sidebar). */
  tabsInline?: boolean;
  /** Open chat tabs. */
  tabs: { id: string; title: string; running: boolean; engine: EngineId }[];
  pending: PendingFile[];
  fileStates: Record<string, 'pending' | 'accepted' | 'rejected'>;
  usage: UsageSnapshot;
  catalogs: { claude: ModelCatalog; cursor: ModelCatalog | null };
  /** Claude's slash commands, from its last session start. */
  slashCommands: string[];
  slashItems: { name: string; description: string; kind: 'skill' | 'command' }[];
  queue: { index?: number; text: string; attachments: number }[];
  selection: { claudeModel: string; claudeEffort: string | null; claudeFast?: boolean; cursorModel: string };
  /** Cursor's CLI answered with no models: it's signed out. */
  cursorSignedOut?: boolean;
}

/** Webview-only state: what is open, typed, or waiting. */
export interface UiState {
  view: 'chat' | 'history';
  menu: null | 'model' | 'mode' | 'usage' | 'context' | 'planner' | 'builder';
  openFiles: Set<string>;
  /** Step groups the person opened or closed; their choice beats the running default. */
  stepChoice: Map<string, boolean>;
  /** Single steps (command output, edit diffs) the person opened. */
  openStepItems: Set<string>;
  openSteps: Set<string>;
  openThinking: Set<string>;
  showAllFiles: Set<string>;
  editingPlan: string | null;
  notices: { id: number; text: string; level: 'info' | 'error' }[];
  mentions: MentionItem[];
  /** Pasted or dropped images waiting to be sent. */
  images: { name: string; mediaType: string; data: string; url: string }[];
  slash: null | { query: string; active: number; showAll?: boolean };
  /** User message whose checkpoint restore is waiting for a second click. */
  confirmRestore: string | null;
  mention: null | {
    query: string;
    scope?: MentionScope;
    groups: MentionGroup[];
    active: number;
    requestId: number;
  };
  modelSearch: string;
  modelActive: number;
}

export interface ExternalChat {
  source: 'claude' | 'cursor';
  id: string;
  title: string;
  updatedAt: number;
}

export const store: {
  host: HostState | null;
  /** Claude Code sessions and Cursor chats for this workspace, for the history view. */
  external: { claude: ExternalChat[]; cursor: ExternalChat[]; loadingCursor: boolean } | null;
  ui: UiState;
  /** Messages keyed by id; streaming text lands here before the host's state catches up. */
  messages: Map<string, ChatMessage>;
  patches: Map<string, string>;
} = {
  host: null,
  external: null,
  ui: {
    view: 'chat',
    menu: null,
    openFiles: new Set(),
    stepChoice: new Map(),
    openStepItems: new Set(),
    openSteps: new Set(),
    openThinking: new Set(),
    showAllFiles: new Set(),
    editingPlan: null,
    notices: [],
    mentions: [],
    images: [],
    slash: null,
    confirmRestore: null,
    mention: null,
    modelSearch: '',
    modelActive: 0,
  },
  messages: new Map(),
  patches: new Map(),
};

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

export function post(msg: Record<string, unknown> & { type: string }): void {
  vscode.postMessage(msg);
}

/** The composer draft survives the webview being hidden and shown again. */
/** Saved webview state: the draft, and which chat this tab shows (for restoring after a reload). */
export function savePersisted(patch: { draft?: string; threadId?: string }): void {
  try {
    const cur = (vscode.getState() as Record<string, unknown> | undefined) ?? {};
    vscode.setState({ ...cur, ...patch });
  } catch {
    /* not available in tests */
  }
}

export function saveDraft(text: string): void {
  savePersisted({ draft: text });
}

export function loadDraft(): string {
  try {
    const s = vscode.getState() as { draft?: string } | undefined;
    return s?.draft ?? '';
  } catch {
    return '';
  }
}

/** A turn is running in this chat (another tab's turn doesn't count). */
export function isRunning(messageId?: string): boolean {
  const r = store.host?.running;
  if (!r) return false;
  if (messageId) return r.messageId === messageId;
  return !r.threadId || r.threadId === store.host?.thread.id;
}
