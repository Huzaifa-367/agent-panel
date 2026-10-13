export type EngineId = 'claude' | 'cursor';

/** agent: edits automatically · ask: asks before each edit or command · plan: read-only · handoff: plan then build. */
export type AgentMode = 'agent' | 'auto' | 'ask' | 'plan' | 'handoff';
/** What one turn runs as: hand-off turns run as agent, plan or ask. */
export type TurnMode = 'agent' | 'auto' | 'ask' | 'plan';

export interface ImageInput {
  name: string;
  mediaType: string;
  /** base64, no data: prefix */
  data: string;
}

export interface TurnTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** Tokens in the conversation as of the last request, and the model's window. */
  contextUsed?: number;
  contextWindow?: number;
}

export type AgentEvent =
  | { kind: 'session'; engine: EngineId; sessionId: string; model: string; slashCommands?: string[] }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; tool: string; title: string; input?: unknown; todos?: TodoItem[]; parentId?: string }
  | { kind: 'tool-end'; id: string; ok: boolean; summary?: string; output?: string; diff?: string; additions?: number; deletions?: number }
  | {
      kind: 'permission';
      id: string;
      tool: string;
      title: string;
      input?: unknown;
      toolUseId?: string;
      suggestions?: unknown[];
    }
  | {
      kind: 'usage';
      fiveHour?: number;
      fiveHourResetsAt?: number;
      sevenDay?: number;
      sevenDayResetsAt?: number;
      status?: string;
    }
  | { kind: 'done'; ok: boolean; costUsd?: number; error?: string; usage?: TurnTokens; durationMs?: number };

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** To-do lists from Claude's TodoWrite or Cursor's todo tool, normalised. */
export function todosFrom(tool: string, input: unknown): TodoItem[] | undefined {
  if (!/todo/i.test(tool) || !input || typeof input !== 'object') return undefined;
  const raw = (input as Record<string, unknown>).todos ?? (input as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const content = String(o.content ?? o.text ?? o.title ?? o.description ?? '').trim();
      const s = String(o.status ?? '').toLowerCase();
      const status: TodoItem['status'] = /complete|done/.test(s) ? 'completed' : /progress|active/.test(s) ? 'in_progress' : 'pending';
      return { content, status };
    })
    .filter((t) => t.content);
}

export type PermissionDecision = 'allow' | 'allow-session' | 'deny';

export interface EngineTurnOptions {
  workspaceRoot: string;
  model: string;
  /** Claude only: `--effort` level. */
  effort?: string;
  /** Claude only: fast mode (Opus). */
  fast?: boolean;
  mode: TurnMode;
  prompt: string;
  images?: ImageInput[];
  sessionId?: string;
  /** The chat this turn belongs to; each chat gets its own Claude process. */
  chatId?: string;
  onEvent: (event: AgentEvent) => void;
}

export interface EngineHandle {
  stop(): void;
  answerPermission?(requestId: string, decision: PermissionDecision, input?: unknown): void;
}

export interface Engine {
  readonly id: EngineId;
  startTurn(options: EngineTurnOptions): EngineHandle;
  /** Optional warm-up so the first real turn is not a cold spawn. */
  prewarm?(workspaceRoot: string, model: string, effort?: string, sessionId?: string, fast?: boolean, chatId?: string): void;
}

export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

/** What a subagent handed back, without the harness's warning line and its two-space indent. */
export function subagentReport(text: string): string {
  const marker = 'The report follows:\n';
  const at = text.indexOf(marker);
  const body = text.startsWith('[Subagent hand-back]') && at >= 0 ? text.slice(at + marker.length) : text;
  return body.replace(/^ {2}/gm, '').trim();
}

export function toolTitle(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const file =
    (typeof obj.file_path === 'string' && obj.file_path) ||
    (typeof obj.path === 'string' && obj.path) ||
    (typeof obj.filePath === 'string' && obj.filePath) ||
    '';
  const name = file ? basename(file) : '';
  const cmd = typeof obj.command === 'string' ? obj.command : '';
  const pattern =
    (typeof obj.pattern === 'string' && obj.pattern) ||
    (typeof obj.globPattern === 'string' && obj.globPattern) ||
    (typeof obj.query === 'string' && obj.query) ||
    '';

  switch (tool) {
    case 'Read':
    case 'readToolCall':
      return name ? `Read \`${name}\`` : 'Read file';
    case 'Edit':
    case 'Write':
    case 'editToolCall':
    case 'writeToolCall':
      return name ? `Edited \`${name}\`` : 'Edited file';
    case 'Bash':
    case 'shellToolCall':
      return cmd ? `Ran \`${truncate(cmd, 60)}\`` : 'Ran command';
    case 'Grep':
    case 'grepToolCall':
      return pattern ? `Searched for \`${truncate(pattern, 40)}\`` : 'Searched';
    case 'Glob':
    case 'globToolCall':
      return pattern ? `Found files matching \`${truncate(pattern, 40)}\`` : 'Found files';
    case 'MultiEdit':
    case 'NotebookEdit':
      return name ? `Edited \`${name}\`` : 'Edited file';
    case 'deleteToolCall':
      return name ? `Deleted \`${name}\`` : 'Deleted file';
    case 'LS':
    case 'lsToolCall':
      return name ? `Listed \`${name}\`` : 'Listed folder';
    case 'WebSearch':
    case 'webSearchToolCall':
      return pattern ? `Searched the web for \`${truncate(pattern, 40)}\`` : 'Searched the web';
    case 'WebFetch': {
      const url = typeof obj.url === 'string' ? obj.url : '';
      return url ? `Fetched \`${truncate(url, 50)}\`` : 'Fetched a page';
    }
    case 'TodoWrite':
    case 'todoToolCall':
    case 'updateTodosToolCall':
      return 'Updated the to-do list';
    case 'Task':
    case 'Agent': {
      const d = typeof obj.description === 'string' ? obj.description : '';
      return d ? `Started a subagent: ${truncate(d, 50)}` : 'Started a subagent';
    }
    case 'readLintsToolCall':
      return 'Read lint errors';
    default: {
      const pretty = tool.replace(/ToolCall$/, '').replace(/^mcp__([^_]+)__/, '$1: ');
      return name ? `${pretty} \`${name}\`` : pretty;
    }
  }
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
