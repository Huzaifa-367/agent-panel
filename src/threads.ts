import type { AgentMode, EngineId, TurnTokens } from './engines/types';

export type StepStatus = 'running' | 'ok' | 'fail' | 'ask' | 'denied';

export interface StepRecord {
  id: string;
  tool: string;
  title: string;
  status: StepStatus;
  summary?: string;
  /** A command step's full command line, and everything it printed. */
  command?: string;
  output?: string;
  /** The file the step touched (workspace-relative), and where. */
  path?: string;
  line?: number;
  /** For edits: this one edit's diff and counts. */
  diff?: string;
  additions?: number;
  deletions?: number;
  /** The subagent step this one ran inside. */
  parentId?: string;
  /** For a subagent step: which agent, what for, and the brief it was given. */
  agent?: { type?: string; description?: string; prompt?: string };
  /** To-do list carried by a todo tool call. */
  todos?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
  /** Set while the step waits for Allow or Deny. `id` is the CLI's permission request id. */
  ask?: { id: string; title: string; detail?: string };
}

export interface TurnFile {
  relPath: string;
  additions: number;
  deletions: number;
  status: 'modified' | 'added' | 'deleted';
}

export interface MentionRef {
  kind: string;
  id: string;
  label: string;
  detail?: string;
}

export interface PlanInfo {
  request: string;
  planner: EngineId;
  builder: EngineId;
  reviewAfter: boolean;
  state: 'ready' | 'building' | 'built';
}

export interface TurnMeta {
  model?: string;
  modelLabel?: string;
  effort?: string;
  mode?: 'agent' | 'auto' | 'ask' | 'plan';
  /** The turn's part in a hand-off. */
  role?: 'planner' | 'builder' | 'reviewer';
  durationMs?: number;
  usage?: TurnTokens;
  error?: string;
  stopped?: boolean;
}

/** One piece of an answer, in the order it happened: thinking, text, or a run of tool steps. */
export type MessagePart =
  | { kind: 'thinking'; text: string; startedAt?: number; endedAt?: number }
  | { kind: 'text'; text: string }
  | { kind: 'steps'; ids: string[] };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  engine?: EngineId;
  text: string;
  createdAt: number;
  thinking?: string;
  steps?: StepRecord[];
  /** The answer as a timeline (Cursor-style); older messages have none. */
  parts?: MessagePart[];
  files?: TurnFile[];
  /** This turn's before and after trees, for its own diff. */
  trees?: { base: string; after: string };
  meta?: TurnMeta;
  mentions?: MentionRef[];
  plan?: PlanInfo;
  /** System notes: which icon to show. */
  icon?: string;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  claudeSessionId?: string;
  cursorSessionId?: string;
  lastEngine?: EngineId;
  engine: EngineId;
  /** Kept for older saved chats; the per-engine fields below win. */
  model: string;
  claudeModel?: string;
  claudeEffort?: string;
  claudeFast?: boolean;
  cursorModel?: string;
  mode: AgentMode;
  planner?: EngineId;
  builder?: EngineId;
  reviewAfter?: boolean;
  /** Imported from Claude Code or Cursor's own chat. */
  source?: { kind: 'claude' | 'cursor'; id: string; syncedAt: number };
  /** Messages in the Claude session file the panel already shows; more means Claude Code added some. */
  claudeSeen?: number;
  /** Engines already given an imported Cursor chat's history. */
  transcriptSentTo?: EngineId[];
}

const CONTEXT_CAP = 24_000;

export interface ThreadDefaults {
  engine: EngineId;
  mode: AgentMode;
  claudeModel: string;
  claudeEffort?: string;
  claudeFast?: boolean;
  cursorModel: string;
  planner: EngineId;
  builder: EngineId;
  reviewAfter: boolean;
}

export function createThread(d: ThreadDefaults): Thread {
  const now = Date.now();
  return {
    id: `t-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
    engine: d.engine,
    model: d.engine === 'claude' ? d.claudeModel : d.cursorModel,
    claudeModel: d.claudeModel,
    claudeEffort: d.claudeEffort,
    claudeFast: d.claudeFast,
    cursorModel: d.cursorModel,
    mode: d.mode,
    planner: d.planner,
    builder: d.builder,
    reviewAfter: d.reviewAfter,
  };
}

/** Engines that answered in a thread, in order of first use. */
export function enginesUsed(thread: Thread): EngineId[] {
  const out: EngineId[] = [];
  for (const m of thread.messages) {
    if (m.role === 'assistant' && m.engine && !out.includes(m.engine)) out.push(m.engine);
  }
  return out;
}

/** Distinct files changed across the thread. */
export function filesChanged(thread: Thread): number {
  const set = new Set<string>();
  for (const m of thread.messages) for (const f of m.files ?? []) set.add(f.relPath);
  return set.size;
}

export function titleFromPrompt(prompt: string): string {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length <= 48 ? one || 'New chat' : `${one.slice(0, 47)}…`;
}

/**
 * The hand-over when the other engine takes over a chat: what was asked, what the other
 * engine said and did (reads, commands and their results, edits), where the work stands
 * (to-dos, plan) and the diff of changes not yet reviewed. Newest work is kept whole;
 * older answers are shortened first so the block stays within its budget.
 */
export function buildHandoverPrefix(
  thread: Thread,
  nextEngine: EngineId,
  pending: { relPath: string; additions: number; deletions: number }[] | string[],
  pendingDiff = '',
): string {
  const msgs = thread.messages;
  let lastIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].engine === nextEngine && msgs[i].role === 'assistant') {
      lastIdx = i;
      break;
    }
  }
  const slice = msgs.slice(lastIdx + 1).filter((m) => m.role !== 'system');
  const other = slice.find((m) => m.role === 'assistant')?.engine ?? (nextEngine === 'claude' ? 'cursor' : 'claude');
  const otherName = other === 'claude' ? 'Claude' : 'Cursor';

  // Each turn as a block; the newest blocks get the most room.
  const blocks = slice.map((m, idx) => {
    const newest = idx >= slice.length - 3;
    if (m.role === 'user') return `User: ${cap(m.text, newest ? 4000 : 1200)}`;
    const lines = [`${otherName}: ${cap(m.text.trim() || '(no text)', newest ? 6000 : 1500)}`];
    const did = workDone(m);
    if (did) lines.push(`  What it did: ${did}`);
    if (m.meta?.error) lines.push(`  Ended with an error: ${cap(m.meta.error, 300)}`);
    if (m.meta?.stopped) lines.push('  It was stopped before finishing.');
    if (m.plan) lines.push(`  This was a plan (${m.plan.state === 'built' ? 'already built' : 'not built yet'}).`);
    return lines.join('\n');
  });

  const todos = [...slice].reverse().flatMap((m) => [...(m.steps ?? [])].reverse()).find((s) => s.todos?.length)?.todos;
  const files = (pending as (string | { relPath: string; additions: number; deletions: number })[]).map((f) =>
    typeof f === 'string' ? f : `${f.relPath} (+${f.additions} −${f.deletions})`,
  );

  const head = [
    `[Hand-over: you are taking over this chat from ${otherName}, in the same workspace.`,
    `Their changes are already on disk. Continue the work from where it stands; don't redo finished steps, and check files before assuming their contents.]`,
    '',
    'Since you last answered:',
  ];
  const tail: string[] = [];
  if (todos?.length) {
    tail.push('', 'Where the work stands (their to-do list):', ...todos.map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`));
  }
  if (files.length) tail.push('', `Changed files not reviewed yet: ${files.join(', ')}`);
  if (pendingDiff.trim()) tail.push('', 'Their diff:', '```diff', cap(pendingDiff, 12_000), '```');
  tail.push('[End hand-over]', '');

  // Fit the budget by dropping the oldest turns, never the newest ones or the work state.
  let body = blocks;
  let text = [...head, ...body, ...tail].join('\n');
  while (text.length > CONTEXT_CAP && body.length > 2) {
    body = body.slice(1);
    text = [...head, '(earlier turns left out)', ...body, ...tail].join('\n');
  }
  return text;
}

/** One line of what a turn did: files read, commands and how they went, edits. */
function workDone(m: ChatMessage): string {
  const steps = m.steps ?? [];
  if (!steps.length && !m.files?.length) return '';
  const read = new Set<string>();
  const edits: string[] = [];
  const runs: string[] = [];
  const other: string[] = [];
  for (const s of steps) {
    if (s.todos) continue;
    const t = s.tool.toLowerCase();
    const plain = s.title.replace(/`/g, '');
    if (t === 'read' || t.startsWith('read')) read.add(s.path ?? plain.replace(/^Read /, ''));
    else if (s.diff !== undefined || /edit|write|delete/.test(t)) edits.push(`${s.path ?? plain.replace(/^(Edited|Deleted) /, '')}${s.additions !== undefined ? ` (+${s.additions} −${s.deletions ?? 0})` : ''}`);
    else if (t === 'bash' || t.includes('shell') || t.includes('terminal')) {
      const out = s.status === 'fail' ? 'failed' : s.status === 'denied' ? 'denied' : 'ok';
      const brief = s.summary && s.status === 'fail' ? `: ${cap(s.summary.split('\n').filter(Boolean).slice(-2).join(' / '), 160)}` : '';
      runs.push(`${plain.replace(/^Ran /, '')} [${out}${brief}]`);
    } else other.push(plain);
  }
  const parts: string[] = [];
  if (read.size) parts.push(`read ${[...read].slice(0, 12).join(', ')}${read.size > 12 ? ` and ${read.size - 12} more` : ''}`);
  if (runs.length) parts.push(`ran ${runs.slice(-6).join('; ')}`);
  if (edits.length) parts.push(`edited ${[...new Set(edits)].join(', ')}`);
  else if (m.files?.length) parts.push(`changed ${m.files.map((f) => f.relPath).join(', ')}`);
  if (other.length) parts.push(other.slice(0, 4).join('; '));
  return parts.join('. ');
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export class ThreadStore {
  constructor(
    private readonly getRaw: () => Thread[] | undefined,
    private readonly setRaw: (threads: Thread[]) => void | Thenable<void>,
  ) {}

  list(): Thread[] {
    return [...(this.getRaw() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * At startup, no turn is running: an answer saved mid-turn (the window reloaded, the extension
   * was updated) is finished off, so it shows no spinner or Allow prompt nobody can answer.
   */
  async settleInterrupted(): Promise<void> {
    let changed = false;
    const all = (this.getRaw() ?? []).map((t) => {
      for (const m of t.messages) {
        if (m.role !== 'assistant' || m.meta) continue;
        const open = (m.steps ?? []).filter((s) => s.status === 'running' || s.status === 'ask');
        if (!open.length) continue;
        for (const s of open) {
          s.status = 'denied';
          s.ask = undefined;
        }
        m.meta = { ...(m.meta ?? {}), error: 'Interrupted: Claude was stopped before it finished (the window reloaded or the extension updated). Your work so far is kept. Press Retry to continue.' } as unknown as typeof m.meta;
        changed = true;
      }
      return t;
    });
    if (changed) await this.setRaw(all);
  }

  get(id: string): Thread | undefined {
    return this.list().find((t) => t.id === id);
  }

  async save(thread: Thread): Promise<void> {
    const all = this.list().filter((t) => t.id !== thread.id);
    all.unshift(thread);
    await this.setRaw(all.slice(0, 50));
  }

  async remove(id: string): Promise<void> {
    await this.setRaw(this.list().filter((t) => t.id !== id));
  }
}
