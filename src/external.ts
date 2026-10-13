import { execFile } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { toolTitle } from './engines/types';
import type { ChatMessage, StepRecord } from './threads';

const exec = promisify(execFile);

/**
 * Chats made outside the panel, for this workspace:
 *
 * - Claude Code sessions (CLI, the official extension, and this panel all write them)
 *   live in ~/.claude/projects/<workspace>/<session>.jsonl. Continuing one in the panel
 *   resumes the same session, so it shows up in the official extension too.
 * - Cursor's own chat panel keeps chats in its state database. They are read here,
 *   never written: that database belongs to the running editor.
 */

export interface ExternalChat {
  source: 'claude' | 'cursor';
  id: string;
  title: string;
  updatedAt: number;
}

// ----- Claude Code sessions -----

/** Claude Code's folder name for a project: every character outside [A-Za-z0-9] becomes `-`. */
export function claudeProjectDir(root: string): string {
  // Claude names the folder from the real path (e.g. /private/var for /var on macOS).
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* keep the path as given */
  }
  return join(homedir(), '.claude', 'projects', real.replace(/[^A-Za-z0-9]/g, '-'));
}

export async function listClaudeSessions(root: string, limit = 50): Promise<ExternalChat[]> {
  const dir = claudeProjectDir(root);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  const out: ExternalChat[] = [];
  for (const { f, mtime } of files) {
    const path = join(dir, f);
    const hit = titleCache.get(path);
    const title = hit && hit.mtime === mtime ? hit.title : await sessionTitle(path);
    titleCache.set(path, { mtime, title });
    if (title) out.push({ source: 'claude', id: f.replace(/\.jsonl$/, ''), title, updatedAt: mtime });
  }
  return out;
}

/** Titles by file, reused until the file changes: big sessions are slow to scan. */
const titleCache = new Map<string, { mtime: number; title: string | undefined }>();

/** The session's title (its AI title or summary), else its first real user message. Empty sessions get none. */
async function sessionTitle(file: string): Promise<string | undefined> {
  let title: string | undefined;
  let firstUser: string | undefined;
  for await (const e of readJsonl(file)) {
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') title = e.aiTitle;
    else if (e.type === 'summary' && typeof e.summary === 'string') title ??= e.summary;
    else if (e.type === 'custom-title' && typeof e.customTitle === 'string') title = e.customTitle;
    else if (!firstUser && e.type === 'user' && !e.isSidechain && !e.isMeta) firstUser = userText(e.message);
  }
  const t = title ?? firstUser;
  return t ? oneLine(t) : undefined;
}

/** A Claude Code session as panel messages: your messages, answers, and tool steps. */
export async function loadClaudeSession(root: string, sessionId: string): Promise<ChatMessage[]> {
  const file = join(claudeProjectDir(root), `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  const out: ChatMessage[] = [];
  let current: ChatMessage | undefined;
  for await (const e of readJsonl(file)) {
    if (e.isSidechain || e.isMeta) continue;
    const at = Date.parse(String(e.timestamp ?? '')) || Date.now();
    if (e.type === 'user') {
      const text = userText(e.message);
      if (!text) continue; // tool results ride in user records; they are not messages
      current = undefined;
      out.push({ id: `cc-${String(e.uuid ?? at)}`, role: 'user', engine: 'claude', text: stripPanelContext(text), createdAt: at });
    } else if (e.type === 'assistant') {
      const msg = (e.message ?? {}) as Record<string, unknown>;
      if (!current) {
        current = { id: `cc-${String(e.uuid ?? at)}`, role: 'assistant', engine: 'claude', text: '', steps: [], createdAt: at, meta: { modelLabel: shortModel(String(msg.model ?? '')) } };
        out.push(current);
      }
      for (const block of Array.isArray(msg.content) ? msg.content : []) {
        const b = (block ?? {}) as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') current.text += (current.text ? '\n\n' : '') + b.text;
        if (b.type === 'tool_use') {
          const step: StepRecord = { id: String(b.id ?? at), tool: String(b.name ?? 'tool'), title: toolTitle(String(b.name ?? 'tool'), b.input), status: 'ok' };
          current.steps!.push(step);
        }
      }
    }
  }
  return out;
}

/** Text of a user record, or nothing when it only carries tool results. */
function userText(message: unknown): string | undefined {
  const m = (message ?? {}) as Record<string, unknown>;
  if (typeof m.content === 'string') return cleanUserText(m.content);
  if (!Array.isArray(m.content)) return undefined;
  const parts = m.content
    .map((b) => (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' ? String((b as Record<string, unknown>).text ?? '') : ''))
    .filter(Boolean);
  return cleanUserText(parts.join('\n'));
}

/** What the person typed, without the harness's wrappers (reminders, task notices, hook output). */
function cleanUserText(raw: string): string | undefined {
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(task-notification|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g, '')
    .trim();
  if (!text || /^<(command-|local-command|bash-|task-notification|system-reminder|user-prompt-submit-hook)/.test(text)) return undefined;
  return text;
}

/** The panel prefixes hand-over and @ context; show only what the person wrote. */
function stripPanelContext(text: string): string {
  return text
    .replace(/^\[Context from the other engine in this thread\][\s\S]*?\[End context\]\n*/, '')
    .replace(/^The user attached this context:[\s\S]*?\n---\n\n/, '')
    .trim();
}

function shortModel(model: string): string {
  const m = /claude-(\w+)-([\d-]+)/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, '.')}` : model;
}

async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      /* a partly written last line */
    }
  }
}

// ----- Cursor chats -----

function cursorDb(): string {
  return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

async function sqlite<T>(sql: string): Promise<T[]> {
  const db = cursorDb();
  if (!existsSync(db)) return [];
  // Read-only, and a busy timeout so Cursor's own writes never wait on us.
  const { stdout } = await exec('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 2000', db, sql], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  return stdout.trim() ? (JSON.parse(stdout) as T[]) : [];
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Cursor chats whose workspace is this folder. Key ranges keep the scan on the index. */
export async function listCursorChats(root: string, limit = 50): Promise<ExternalChat[]> {
  const rows = await sqlite<{ id: string; name: string | null; updated: number | null; created: number | null }>(
    `select substr(key, 14) as id, json_extract(value, '$.name') as name, json_extract(value, '$.lastUpdatedAt') as updated, json_extract(value, '$.createdAt') as created
     from cursorDiskKV where key >= 'composerData:' and key < 'composerData;'
     and json_extract(value, '$.workspaceIdentifier.uri.fsPath') = ${q(root)}
     and json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) > 0
     order by updated desc limit ${limit}`,
  );
  return rows.map((r) => ({ source: 'cursor', id: r.id, title: oneLine(r.name || 'Untitled Cursor chat'), updatedAt: r.updated ?? r.created ?? 0 }));
}

/** A Cursor chat's messages, in order. Tool bubbles become steps on the answer they belong to. */
export async function loadCursorChat(composerId: string): Promise<ChatMessage[]> {
  if (!/^[\w-]+$/.test(composerId)) return [];
  const rows = await sqlite<{ key: string; type: number; text: string | null; created: string | null; tool: string | null }>(
    `select key, json_extract(value, '$.type') as type, json_extract(value, '$.text') as text,
            json_extract(value, '$.createdAt') as created, json_extract(value, '$.toolFormerData.name') as tool
     from cursorDiskKV where key >= ${q(`bubbleId:${composerId}:`)} and key < ${q(`bubbleId:${composerId};`)}`,
  );
  const order = await sqlite<{ h: string }>(
    `select json_extract(value, '$.fullConversationHeadersOnly') as h from cursorDiskKV where key = ${q(`composerData:${composerId}`)}`,
  );
  const ids: string[] = order[0]?.h ? (JSON.parse(order[0].h) as { bubbleId: string }[]).map((x) => x.bubbleId) : [];
  const byId = new Map(rows.map((r) => [r.key.slice(r.key.lastIndexOf(':') + 1), r]));
  const out: ChatMessage[] = [];
  let current: ChatMessage | undefined;
  for (const id of ids.length ? ids : [...byId.keys()]) {
    const r = byId.get(id);
    if (!r) continue;
    const at = Date.parse(r.created ?? '') || 0;
    if (Number(r.type) === 1) {
      if (!r.text?.trim()) continue;
      current = undefined;
      out.push({ id: `cu-${id}`, role: 'user', engine: 'cursor', text: r.text.trim(), createdAt: at });
    } else {
      if (!current) {
        current = { id: `cu-${id}`, role: 'assistant', engine: 'cursor', text: '', steps: [], createdAt: at, meta: { modelLabel: 'Cursor chat' } };
        out.push(current);
      }
      if (r.text?.trim()) current.text += (current.text ? '\n\n' : '') + r.text.trim();
      if (r.tool) current.steps!.push({ id, tool: r.tool, title: prettyCursorTool(r.tool), status: 'ok' });
    }
  }
  return out.filter((m) => m.role === 'user' || m.text || m.steps?.length);
}

function prettyCursorTool(name: string): string {
  const words = name.replace(/_v\d+$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 69)}…` : t;
}

/** Short transcript of an imported chat, to hand to an engine that wasn't part of it. */
export function transcript(messages: ChatMessage[], cap = 12_000): string {
  const lines = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`);
  let text = lines.join('\n\n');
  if (text.length > cap) text = `…${text.slice(text.length - cap)}`;
  return `[Earlier conversation, from Cursor's chat]\n${text}\n[End of earlier conversation]\n\n`;
}
