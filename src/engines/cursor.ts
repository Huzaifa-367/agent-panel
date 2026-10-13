import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCursorModels, type ModelCatalog } from '../models';
import {
  type AgentEvent,
  type Engine,
  type EngineHandle,
  type EngineTurnOptions,
  toolTitle,
  todosFrom,
  basename,
} from './types';

type Json = Record<string, unknown>;

const FALLBACK_LIST = [
  'auto - Auto',
  'composer-2.5 - Composer 2.5',
  'gpt-5.3-codex - Codex 5.3',
  'claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking',
].join('\n');

/**
 * Find Cursor's `agent` CLI by full path. An editor started from the Dock does not
 * always inherit the shell PATH, so `agent` alone can fail to spawn.
 */
export function resolveCursorBinary(): string {
  const fromEnv = process.env.AGENT_PANEL_CURSOR_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ['cursor-agent', 'agent']) {
    const candidate = join(homedir(), '.local', 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return 'agent';
}

export class CursorStreamParser {
  private sessionId: string | undefined;
  private model = '';
  private assistantParts: string[] = [];
  private lastEmittedAssistant = '';
  private openCalls = new Set<string>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  pushLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg: Json;
    try {
      msg = JSON.parse(trimmed) as Json;
    } catch {
      return;
    }
    this.handle(msg);
  }

  private handle(msg: Json): void {
    const type = String(msg.type ?? '');
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined;

    if (type === 'system' && subtype === 'init') {
      this.sessionId = String(msg.session_id ?? '');
      this.model = String(msg.model ?? '');
      if (this.sessionId) {
        this.emit({
          kind: 'session',
          engine: 'cursor',
          sessionId: this.sessionId,
          model: this.model,
        });
      }
      return;
    }

    if (type === 'thinking') {
      if (subtype === 'delta' && typeof msg.text === 'string') {
        this.emit({ kind: 'thinking', delta: msg.text });
      }
      return;
    }

    if (type === 'assistant') {
      const message = (msg.message ?? {}) as Json;
      const content = Array.isArray(message.content) ? message.content : [];
      let text = '';
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Json).type === 'text') {
          text += String((block as Json).text ?? '');
        }
      }
      if (!text) {
        return;
      }
      // Stream-partial: emit only the newly appended suffix when text grows;
      // skip full-final duplicates that equal the concatenation already sent.
      if (text.startsWith(this.lastEmittedAssistant) && text.length > this.lastEmittedAssistant.length) {
        const delta = text.slice(this.lastEmittedAssistant.length);
        this.lastEmittedAssistant = text;
        this.assistantParts.push(delta);
        this.emit({ kind: 'text', delta });
        return;
      }
      if (text === this.lastEmittedAssistant) {
        return;
      }
      // Non-overlapping partial chunk
      if (!this.lastEmittedAssistant || !this.lastEmittedAssistant.startsWith(text)) {
        this.assistantParts.push(text);
        this.lastEmittedAssistant += text;
        this.emit({ kind: 'text', delta: text });
      }
      return;
    }

    if (type === 'tool_call') {
      const callId = String(msg.call_id ?? '');
      const toolCall = (msg.tool_call ?? {}) as Json;
      const { tool, input, summary, output, ok, diff, additions, deletions } = describeCursorTool(toolCall);
      if (subtype === 'started') {
        if (callId) {
          this.openCalls.add(callId);
        }
        this.emit({
          kind: 'tool-start',
          id: callId || `tool-${Date.now()}`,
          tool,
          title: toolTitle(tool, input),
          input,
          todos: todosFrom(tool, input),
        });
        return;
      }
      if (subtype === 'completed') {
        if (callId) {
          this.openCalls.delete(callId);
        }
        this.emit({
          kind: 'tool-end',
          id: callId || `tool-${Date.now()}`,
          ok: ok !== false,
          summary,
          output,
          diff,
          additions,
          deletions,
        });
      }
      return;
    }

    if (type === 'result') {
      const ok = subtype === 'success' && msg.is_error !== true;
      const u = (msg.usage ?? {}) as Json;
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      this.emit({
        kind: 'done',
        ok,
        durationMs: n(msg.duration_ms),
        usage: {
          inputTokens: n(u.inputTokens),
          outputTokens: n(u.outputTokens),
          cacheReadTokens: n(u.cacheReadTokens),
          cacheWriteTokens: n(u.cacheWriteTokens),
        },
        error: ok ? undefined : describeCursorError(String(msg.result ?? subtype ?? '')),
      });
    }
  }
}

function describeCursorTool(toolCall: Json): {
  tool: string;
  input: unknown;
  summary?: string;
  output?: string;
  ok?: boolean;
  diff?: string;
  additions?: number;
  deletions?: number;
} {
  for (const [key, value] of Object.entries(toolCall)) {
    if (!key.endsWith('ToolCall') || !value || typeof value !== 'object') {
      continue;
    }
    const body = value as Json;
    const args = (body.args ?? {}) as Json;
    const result = body.result as Json | undefined;
    const success = result && typeof result === 'object' ? (result.success as Json | undefined) : undefined;
    const tool = key;
    let summary: string | undefined;
    if (success) {
      if (typeof success.linesAdded === 'number' || typeof success.linesRemoved === 'number') {
        summary = `+${Number(success.linesAdded ?? 0)} −${Number(success.linesRemoved ?? 0)}`;
      } else if (typeof success.stdout === 'string' && success.stdout.trim()) {
        summary = success.stdout.trim().slice(0, 4000);
      } else if (Array.isArray(success.files)) {
        summary = `${success.files.length} files`;
      } else if (typeof success.message === 'string') {
        summary = success.message;
      }
    }
    const output = success
      ? [success.stdout, success.stderr].filter((x): x is string => typeof x === 'string').map((x) => x.replace(/\s+$/, '')).filter(Boolean).join('\n') || undefined
      : undefined;
    const path =
      (typeof args.path === 'string' && args.path) ||
      (typeof success?.path === 'string' && success.path) ||
      '';
    const input = {
      ...args,
      path,
      file_path: path,
      command: typeof args.command === 'string' ? args.command : undefined,
      pattern:
        (typeof args.globPattern === 'string' && args.globPattern) ||
        (typeof args.pattern === 'string' && args.pattern) ||
        undefined,
    };
    return {
      tool,
      input,
      summary,
      output,
      ok: !result || Boolean(success) || !('error' in (result ?? {})),
      diff: typeof success?.diffString === 'string' ? success.diffString.replace(/^(---|\+\+\+) .*\n/gm, '') : undefined,
      additions: typeof success?.linesAdded === 'number' ? success.linesAdded : undefined,
      deletions: typeof success?.linesRemoved === 'number' ? success.linesRemoved : undefined,
    };
  }
  return { tool: 'tool', input: {} };
}

/** Turn Cursor's error text into a sentence a person can act on. */
export function describeCursorError(text: string): string {
  const t = text.trim();
  if (/out of usage|usage limit|ActionRequiredError/i.test(t)) {
    return "Cursor stopped: you're out of usage for this model.";
  }
  if (/not (logged|signed) in|unauthori[sz]ed|login required/i.test(t)) {
    return "Cursor isn't signed in. Run `agent login` in a terminal, then retry.";
  }
  return t.slice(0, 500) || 'Cursor stopped with an error.';
}

export interface CursorEngine extends Engine {
  readonly bin: string;
  /** The model list; `fresh` skips the in-memory copy and asks the CLI again. */
  catalog(fresh?: boolean): Promise<ModelCatalog>;
}

export function createCursorEngine(cliPath = resolveCursorBinary()): CursorEngine {
  let cached: ModelCatalog | undefined;

  return {
    id: 'cursor',
    bin: cliPath,
    async catalog(fresh = false) {
      if (cached && !fresh) {
        return cached;
      }
      try {
        const listed = parseCursorModels(await runCapture(cliPath, ['--list-models']));
        // An empty list means the CLI is signed out: say so, don't pretend.
        if (!listed.families.length) return { ...parseCursorModels(FALLBACK_LIST), source: 'fallback' };
        cached = { ...listed, source: 'cli' };
      } catch {
        // Not cached on failure, so the next open tries again.
        return { ...parseCursorModels(FALLBACK_LIST), source: 'fallback' };
      }
      return cached;
    },
    startTurn(options: EngineTurnOptions): EngineHandle {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--trust',
        '--workspace',
        options.workspaceRoot,
        '--model',
        options.model,
      ];
      // plan: read-only. ask: Cursor's print mode proposes edits without applying them.
      if (options.mode === 'plan') {
        args.push('--mode', 'plan');
      } else if (options.mode === 'agent' || options.mode === 'auto') {
        args.push('--force');
      }
      if (options.sessionId) {
        args.push('--resume', options.sessionId);
      }
      args.push(options.prompt);

      const proc = spawn(cliPath, args, {
        cwd: options.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const parser = new CursorStreamParser(options.onEvent);
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => parser.pushLine(line));

      let stderr = '';
      proc.stderr.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8');
      });
      proc.on('error', (err) => {
        options.onEvent({
          kind: 'done',
          ok: false,
          error: `Couldn't start Cursor's agent CLI (${err.message}). Install it with \`curl https://cursor.com/install -fsS | bash\`.`,
        });
      });
      proc.on('exit', (code, signal) => {
        if (signal === 'SIGTERM') {
          options.onEvent({ kind: 'done', ok: false, error: 'Stopped.' });
        } else if (code && code !== 0) {
          options.onEvent({
            kind: 'done',
            ok: false,
            error: describeCursorError(stderr || `agent exited with code ${code}`),
          });
        }
      });

      return {
        stop() {
          if (!proc.killed) {
            proc.kill('SIGTERM');
          }
        },
      };
    },
  };
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => proc.kill('SIGTERM'), 60_000);
    proc.on('exit', () => clearTimeout(timer));
    let out = '';
    let err = '';
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8');
    });
    proc.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err || `exit ${code}`));
      }
    });
  });
}

export function cursorEditTitle(path: string): string {
  return `Edited \`${basename(path)}\``;
}
