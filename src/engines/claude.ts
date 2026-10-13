import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  type Engine,
  type EngineHandle,
  type EngineTurnOptions,
  type PermissionDecision,
  toolTitle,
  todosFrom,
} from './types';

type Json = Record<string, unknown>;

/**
 * Resolve the Claude binary the same way Anthropic.claude-code does:
 * bundled native-binary in the installed extension, else PATH / local install.
 */
export function resolveClaudeBinary(explicit?: string): string {
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.AGENT_PANEL_CLAUDE_BIN;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const extRoot = findClaudeCodeExtensionRoot();
  if (extRoot) {
    const bundled = join(extRoot, 'resources', 'native-binary', 'claude');
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  const versionsDir = join(homedir(), '.local', 'share', 'claude', 'versions');
  if (existsSync(versionsDir)) {
    const versions = readdirSync(versionsDir)
      .filter((name) => !name.startsWith('.'))
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = join(versionsDir, version);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return 'claude';
}

function findClaudeCodeExtensionRoot(): string | undefined {
  const roots = [
    join(homedir(), '.cursor', 'extensions'),
    join(homedir(), '.vscode', 'extensions'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    const matches = readdirSync(root)
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse();
    for (const name of matches) {
      const dir = join(root, name);
      if (existsSync(join(dir, 'resources', 'native-binary', 'claude'))) {
        return dir;
      }
    }
  }
  return undefined;
}

function flag(name: string, value?: string | number | null): string {
  if (value === undefined || value === null) {
    return `--${name}`;
  }
  return `--${name}=${value}`;
}

export class ClaudeStreamParser {
  private sessionId: string | undefined;
  private model = '';
  private openTools = new Map<string, { tool: string; input: unknown }>();
  /** Tool input as it streams in, by content block index: the command shows before it's complete. */
  private liveInputs = new Map<number, { id: string; tool: string; json: string; sent: number }>();
  private textSeen = '';
  /** Pending can_use_tool suggestions keyed by request_id. */
  readonly permissionSuggestions = new Map<string, unknown[]>();

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

    // Anthropic.claude-code ignores these on the host read loop.
    if (type === 'keep_alive' || type === 'control_response' || type === 'control_cancel_request') {
      return;
    }

    if (type === 'system' && subtype === 'init') {
      this.sessionId = String(msg.session_id ?? '');
      this.model = String(msg.model ?? '');
      if (this.sessionId) {
        this.emit({
          kind: 'session',
          engine: 'claude',
          sessionId: this.sessionId,
          model: this.model,
          slashCommands: Array.isArray(msg.slash_commands) ? (msg.slash_commands as unknown[]).map(String) : undefined,
        });
      }
      return;
    }

    if (type === 'system' && (subtype?.startsWith('hook_') || subtype === 'status')) {
      return;
    }

    if (type === 'system' && subtype === 'permission_denied') {
      const id = String(msg.tool_use_id ?? msg.uuid ?? `denied-${Date.now()}`);
      const tool = String(msg.tool_name ?? 'tool');
      this.emit({
        kind: 'tool-end',
        id,
        ok: false,
        summary: String(msg.message ?? 'Permission denied'),
      });
      return;
    }

    if (type === 'rate_limit_event') {
      const info = (msg.rate_limit_info ?? {}) as Json;
      const windows = (info.unifiedWindows ?? {}) as Json;
      const five = (windows.five_hour ?? {}) as Json;
      const seven = (windows.seven_day ?? {}) as Json;
      this.emit({
        kind: 'usage',
        fiveHour: num(five.utilization),
        fiveHourResetsAt: num(five.resetsAt),
        sevenDay: num(seven.utilization),
        sevenDayResetsAt: num(seven.resetsAt) ?? num(info.resetsAt),
        status: typeof info.status === 'string' ? info.status : undefined,
      });
      return;
    }

    // Messages from inside a subagent name the subagent's own tool call as their parent.
    const parent = typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id ? msg.parent_tool_use_id : undefined;

    if (type === 'stream_event') {
      this.handleStreamEvent((msg.event ?? {}) as Json, parent);
      return;
    }

    if (type === 'assistant') {
      const message = (msg.message ?? {}) as Json;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const b = block as Json;
        if (b.type === 'text' && typeof b.text === 'string') {
          continue;
        }
        if (b.type === 'tool_use') {
          const id = String(b.id ?? '');
          const tool = String(b.name ?? 'tool');
          const input = b.input;
          // The stream's content_block_start carries an empty input; the full message
          // repeats the tool with its input, so re-emit it to fill the title in.
          this.openTools.set(id, { tool, input });
          if (id) {
            this.emit({ kind: 'tool-start', id, tool, title: toolTitle(tool, input), input, todos: todosFrom(tool, input), parentId: parent });
          }
        }
      }
      return;
    }

    if (type === 'user') {
      const message = (msg.message ?? {}) as Json;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') {
          continue;
        }
        const b = block as Json;
        if (b.type !== 'tool_result') {
          continue;
        }
        const id = String(b.tool_use_id ?? '');
        const ok = b.is_error !== true;
        const summary = summarizeToolResult(msg.tool_use_result, b.content);
        if (id) {
          this.openTools.delete(id);
          this.emit({ kind: 'tool-end', id, ok, summary, output: fullToolOutput(msg.tool_use_result, b.content) });
        }
      }
      return;
    }

    if (type === 'control_request') {
      const request = (msg.request ?? {}) as Json;
      if (request.subtype === 'can_use_tool') {
        const id = String(msg.request_id ?? '');
        const tool = String(request.tool_name ?? 'tool');
        const input = request.input;
        const suggestions = Array.isArray(request.permission_suggestions)
          ? (request.permission_suggestions as unknown[])
          : [];
        if (id && suggestions.length) {
          this.permissionSuggestions.set(id, suggestions);
        }
        this.emit({
          kind: 'permission',
          id,
          tool,
          title: toolTitle(tool, input),
          input,
          toolUseId: typeof request.tool_use_id === 'string' ? request.tool_use_id : undefined,
          suggestions,
        });
      }
      return;
    }

    if (type === 'result') {
      const ok = subtype === 'success' && msg.is_error !== true;
      const u = (msg.usage ?? {}) as Json;
      // The last request's prompt is the conversation's current size; the turn total
      // counts the same context once per tool round-trip.
      const iterations = Array.isArray(u.iterations) ? (u.iterations as Json[]) : [];
      const lastReq = iterations[iterations.length - 1] ?? u;
      const contextUsed = (num(lastReq.input_tokens) ?? 0) + (num(lastReq.cache_read_input_tokens) ?? 0) + (num(lastReq.cache_creation_input_tokens) ?? 0) + (num(lastReq.output_tokens) ?? 0);
      const windows = Object.values((msg.modelUsage ?? {}) as Record<string, Json>).map((x) => num(x.contextWindow)).filter((x): x is number => Boolean(x));
      this.emit({
        kind: 'done',
        ok,
        costUsd: num(msg.total_cost_usd),
        durationMs: num(msg.duration_ms),
        usage: {
          inputTokens: num(u.input_tokens),
          outputTokens: num(u.output_tokens),
          cacheReadTokens: num(u.cache_read_input_tokens),
          cacheWriteTokens: num(u.cache_creation_input_tokens),
          costUsd: num(msg.total_cost_usd),
          contextUsed: contextUsed || undefined,
          contextWindow: windows.length ? Math.max(...windows) : undefined,
        },
        error: ok ? undefined : describeClaudeError(msg),
      });
    }
  }

  /** Fill in a running tool's title from its half-arrived input (the command, file or pattern). */
  private liveInput(index: number, chunk: string): void {
    const live = this.liveInputs.get(index);
    if (!live) return;
    live.json += chunk;
    // Re-send as the text grows, not on every few characters.
    if (live.json.length - live.sent < 24 && live.sent > 0 && !live.json.trimEnd().endsWith('}')) return;
    const input = partialInput(live.json);
    if (!input) return;
    live.sent = live.json.length;
    this.emit({ kind: 'tool-start', id: live.id, tool: live.tool, title: toolTitle(live.tool, input), input, todos: undefined });
  }

  private handleStreamEvent(event: Json, parent?: string): void {
    const et = String(event.type ?? '');
    if (parent) {
      // A subagent's own stream: only its tool calls matter, as children of its step. Its text
      // and thinking are not the answer, and its block indexes would clash with ours.
      const block = (event.content_block ?? {}) as Json;
      if (et === 'content_block_start' && block.type === 'tool_use' && block.id) {
        const tool = String(block.name ?? 'tool');
        this.openTools.set(String(block.id), { tool, input: block.input });
        this.emit({ kind: 'tool-start', id: String(block.id), tool, title: toolTitle(tool, block.input), input: block.input, parentId: parent });
      }
      return;
    }
    if (et === 'content_block_start') {
      const block = (event.content_block ?? {}) as Json;
      // A new text block after earlier text is a new paragraph, not a run-on sentence.
      if (block.type === 'text' && this.textSeen && !this.textSeen.endsWith('\n')) {
        this.textSeen += '\n\n';
        this.emit({ kind: 'text', delta: '\n\n' });
      }
      if (block.type === 'tool_use') {
        const id = String(block.id ?? '');
        const tool = String(block.name ?? 'tool');
        if (id) {
          this.openTools.set(id, { tool, input: block.input });
          this.liveInputs.set(Number(event.index ?? -1), { id, tool, json: '', sent: 0 });
          this.emit({
            kind: 'tool-start',
            id,
            tool,
            title: toolTitle(tool, block.input),
            input: block.input,
          });
        }
      }
      return;
    }
    if (et === 'content_block_delta') {
      const delta = (event.delta ?? {}) as Json;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.textSeen += delta.text;
        this.emit({ kind: 'text', delta: delta.text });
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        this.liveInput(Number(event.index ?? -1), delta.partial_json);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.emit({ kind: 'thinking', delta: delta.thinking });
      }
    }
  }
}

/** Turn a failed `result` into a sentence a person can act on. */
function describeClaudeError(msg: Json): string {
  const subtype = String(msg.subtype ?? 'error');
  const text = typeof msg.result === 'string' ? msg.result : '';
  if (subtype === 'error_max_turns') return 'Claude stopped: it reached the turn limit.';
  if (subtype === 'error_during_execution') return text || 'Claude stopped with an error while working.';
  return text || `Claude stopped (${subtype}).`;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Everything a tool printed: stdout then stderr, or the result's text blocks. */
function fullToolOutput(toolUseResult: unknown, content: unknown): string | undefined {
  const parts: string[] = [];
  if (toolUseResult && typeof toolUseResult === 'object') {
    const r = toolUseResult as Json;
    if (typeof r.stdout === 'string' && r.stdout.trim()) parts.push(r.stdout.replace(/\s+$/, ''));
    if (typeof r.stderr === 'string' && r.stderr.trim()) parts.push(r.stderr.replace(/\s+$/, ''));
  }
  if (!parts.length) {
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const c of content) if (c && typeof c === 'object' && typeof (c as Json).text === 'string') parts.push(String((c as Json).text));
    }
  }
  const text = parts.join('\n').replace(/\s+$/, '');
  return text || undefined;
}

function summarizeToolResult(toolUseResult: unknown, content: unknown): string | undefined {
  if (toolUseResult && typeof toolUseResult === 'object') {
    const r = toolUseResult as Json;
    if (typeof r.stdout === 'string' && r.stdout.trim()) {
      return r.stdout.trim().slice(0, 500);
    }
    if (typeof r.filePath === 'string') {
      return String(r.type ?? 'ok');
    }
    if (typeof r.type === 'string') {
      return r.type;
    }
  }
  if (typeof content === 'string') {
    return content.slice(0, 500);
  }
  return undefined;
}

function describeExit(stderr: string, code: number): string {
  const text = stderr.trim();
  if (/not logged in|login|authenticat|unauthori[sz]ed|\/login/i.test(text)) {
    return "Claude isn't signed in. Run `claude` in a terminal, sign in, then retry.";
  }
  return text.slice(0, 500) || `Claude exited with code ${code}.`;
}

function buildClaudeEnv(): NodeJS.ProcessEnv {
  // Match Anthropic.claude-code getClaudeBinary env shaping.
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CLAUDE_CODE_ENTRYPOINT = env.AGENT_PANEL_CLAUDE_ENTRYPOINT || 'agent-panel';
  delete env.NODE_OPTIONS;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  delete env.TRACEPARENT;
  delete env.TRACESTATE;
  return env;
}

/**
 * Spawn argv aligned with Anthropic.claude-code's ProcessTransport + VS Code host.
 * Skips debug/auth-status chatter that adds host work without helping the panel.
 */
export function buildClaudeArgs(options: {
  model: string;
  permissionMode: string;
  sessionId?: string;
  effort?: string;
}): string[] {
  const args = [
    flag('output-format', 'stream-json'),
    flag('verbose'),
    flag('input-format', 'stream-json'),
    flag('permission-prompt-tool', 'stdio'),
    flag('setting-sources', 'user,project,local'),
    flag('permission-mode', options.permissionMode),
    // Only makes bypass available, so a chat can switch to Auto without a restart.
    flag('allow-dangerously-skip-permissions'),
    flag('include-partial-messages'),
    flag('model', options.model),
    flag('no-chrome'),
    flag('replay-user-messages'),
  ];
  if (options.effort) {
    args.push(flag('effort', options.effort));
  }
  if (options.sessionId) {
    args.push(flag('resume', options.sessionId));
  }
  return args;
}

export function createClaudeEngine(cliPath?: string): Engine {
  const resolvedBin = resolveClaudeBinary(cliPath);
  /**
   * One long-lived CLI process per chat. A single shared process meant opening or switching to
   * another chat killed the running one (exit code 143 on the next turn) and let two chats'
   * events and permission answers cross.
   */
  interface Slot {
    proc?: ChildProcessWithoutNullStreams;
    root?: string;
    model?: string;
    permMode?: string;
    effort?: string;
    fast: boolean;
    session?: string;
    parser?: ClaudeStreamParser;
    onEvent?: (event: AgentEvent) => void;
    bound: boolean;
    /** A turn is running on this process. */
    busy?: boolean;
    /** The CLI's `total_cost_usd` counts the whole process; a turn shows its own share. */
    costBase: number;
  }
  const slots = new Map<string, Slot>();
  const slotFor = (chatId: string | undefined): Slot => {
    const key = chatId || '_';
    let slot = slots.get(key);
    if (!slot) {
      slot = { fast: false, bound: false, costBase: 0 };
      slots.set(key, slot);
    }
    return slot;
  };
  let controlSeq = 0;

  function writeStdin(proc: ChildProcessWithoutNullStreams, payload: unknown): boolean {
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function ensureProcess(
    slot: Slot,
    root: string,
    model: string,
    mode: 'agent' | 'auto' | 'ask' | 'plan',
    sessionId?: string,
    effort?: string,
    fast = false,
  ): ChildProcessWithoutNullStreams {
    // Agent: acceptEdits (fast — no per-edit permission round-trips).
    // Plan: plan. stdio permission tool still handles anything that prompts.
    // Auto: nothing asks, commands included.
    const permissionMode = mode === 'plan' ? 'plan' : mode === 'ask' ? 'default' : mode === 'auto' ? 'bypassPermissions' : 'acceptEdits';
    const alive = Boolean(slot.proc && !slot.proc.killed && slot.proc.exitCode === null);
    // Model, mode, effort and fast mode change inside the running session (like the official
    // extension), so a switch costs no cold start. Only these need a fresh process: a
    // different folder or chat, and "max" effort or clearing effort, which only the flag sets.
    const needNew =
      !alive ||
      slot.root !== root ||
      (sessionId ?? null) !== (slot.session ?? null) ||
      (effort !== slot.effort && (effort === 'max' || slot.effort === 'max' || effort === undefined));

    if (needNew) {
      if (slot.proc && !slot.proc.killed) {
        slot.proc.kill('SIGTERM');
      }
      const args = buildClaudeArgs({ model, permissionMode, sessionId, effort });
      slot.costBase = 0;
      slot.proc = spawn(resolvedBin, args, {
        cwd: root,
        env: buildClaudeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      slot.root = root;
      slot.model = model;
      slot.permMode = permissionMode;
      slot.effort = effort;
      slot.session = sessionId;
      slot.fast = false;
      slot.bound = false;
    } else if (slot.proc) {
      const control = (request: Json) => writeStdin(slot.proc!, { type: 'control_request', request_id: `ap-${(controlSeq += 1)}`, request });
      if (model !== slot.model) {
        control({ subtype: 'set_model', model });
        slot.model = model;
      }
      if (permissionMode !== slot.permMode) {
        control({ subtype: 'set_permission_mode', mode: permissionMode });
        slot.permMode = permissionMode;
      }
      if (effort !== slot.effort && effort) {
        control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
        slot.effort = effort;
      }
    }
    if (slot.proc && fast !== slot.fast) {
      writeStdin(slot.proc, { type: 'control_request', request_id: `ap-${(controlSeq += 1)}`, request: { subtype: 'apply_flag_settings', settings: { fastMode: fast } } });
      slot.fast = fast;
    }

    if (!slot.bound && slot.proc) {
      const proc = slot.proc;
      // Only the chat's current process counts: one we replaced (and killed) on purpose must
      // not fail the turn that replaced it, or clear its slot.
      const current = () => slot.proc === proc;
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        if (current()) slot.parser?.pushLine(line);
      });
      let stderr = '';
      proc.stderr.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8');
      });
      proc.on('error', (err) => {
        if (current()) slot.onEvent?.({ kind: 'done', ok: false, error: `Couldn't start Claude: ${err.message}` });
      });
      proc.stdin.on('error', () => {
        /* EPIPE after the process died: the exit handler reports it */
      });
      proc.on('exit', (code, signal) => {
        if (!current()) return;
        const wasBusy = slot.busy;
        slot.busy = false;
        // A turn in flight must always end, whatever the exit code: a signal or a clean exit has code 0 or null.
        if (wasBusy) {
          slot.onEvent?.({
            kind: 'done',
            ok: false,
            error: code ? describeExit(stderr, code) : `Claude stopped unexpectedly${signal ? ` (${signal})` : ''}.${stderr.trim() ? ` ${stderr.trim().slice(-300)}` : ''}`,
          });
        }
        slot.onEvent = undefined;
        slot.proc = undefined;
        slot.bound = false;
      });
      slot.bound = true;
    }

    return slot.proc!;
  }

  return {
    id: 'claude',
    dispose(chatId?: string) {
      for (const [key, slot] of slots) {
        if (chatId !== undefined && key !== chatId) continue;
        slot.onEvent = undefined;
        slot.proc?.kill();
        slots.delete(key);
      }
    },
    prewarm(workspaceRoot: string, model: string, effort?: string, sessionId?: string, fast?: boolean, chatId?: string) {
      // Cold Claude spawn is the main delay; start the chat's long-lived process early.
      try {
        const slot = slotFor(chatId);
        // Never replace a process that is in the middle of a turn.
        if (slot.proc && slot.busy) return;
        ensureProcess(slot, workspaceRoot, model, 'agent', sessionId, effort, fast);
      } catch {
        /* ignore warm-up failures */
      }
    },
    startTurn(options: EngineTurnOptions): EngineHandle {
      const slot = slotFor(options.chatId);
      slot.onEvent = options.onEvent;
      slot.busy = true;
      const parser = new ClaudeStreamParser((event) => {
        if (event.kind === 'session') {
          slot.session = event.sessionId;
        }
        if (event.kind === 'done') slot.busy = false;
        if (event.kind === 'done' && event.costUsd !== undefined) {
          const total = event.costUsd;
          const turn = turnCost(total, slot.costBase);
          slot.costBase = total;
          event = { ...event, costUsd: turn, usage: event.usage ? { ...event.usage, costUsd: turn } : event.usage };
        }
        options.onEvent(event);
      });
      slot.parser = parser;
      const proc = ensureProcess(
        slot,
        options.workspaceRoot,
        options.model,
        options.mode,
        options.sessionId,
        options.effort,
        options.fast,
      );
      // Same user envelope the SDK / Claude Code extension writes.
      // Images go in as native content blocks, ahead of the text.
      const content = options.images?.length
        ? [
            ...options.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
            { type: 'text', text: options.prompt },
          ]
        : options.prompt;
      writeStdin(proc, { type: 'user', message: { role: 'user', content } });

      return {
        stop() {
          const id = `irq-${Date.now()}`;
          // Anthropic.claude-code interrupt supports cancel_queued for Stop.
          if (
            !writeStdin(proc, {
              type: 'control_request',
              request_id: id,
              request: { subtype: 'interrupt', cancel_queued: true },
            })
          ) {
            proc.kill('SIGTERM');
          }
        },
        answerPermission(requestId: string, decision: PermissionDecision, input?: unknown) {
          if (decision === 'deny') {
            writeStdin(proc, {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: requestId,
                response: { behavior: 'deny', message: 'User denied' },
              },
            });
            parser?.permissionSuggestions.delete(requestId);
            return;
          }

          const suggestions = parser?.permissionSuggestions.get(requestId) ?? [];
          const body: Json = {
            behavior: 'allow',
            updatedInput: input ?? {},
          };
          // "Allow for this chat" → echo permission_suggestions (setMode acceptEdits)
          // the same way Anthropic.claude-code returns updatedPermissions.
          if (decision === 'allow-session' && suggestions.length) {
            body.updatedPermissions = suggestions;
          }
          writeStdin(proc, {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response: body,
            },
          });

          if (decision === 'allow-session') {
            // Also set session mode via control protocol (extension setPermissionMode).
            const modeReqId = `mode-${Date.now()}`;
            writeStdin(proc, {
              type: 'control_request',
              request_id: modeReqId,
              request: { subtype: 'set_permission_mode', mode: 'acceptEdits' },
            });
          }
          parser?.permissionSuggestions.delete(requestId);
        },
      };
    },
  };
}


export interface ClaudeInit {
  models: { value: string; displayName?: string; description?: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[]; supportsFastMode?: boolean }[];
  commands: { name: string; description?: string; argumentHint?: string; aliases?: string[]; builtin?: boolean }[];
  account?: { email?: string; subscriptionType?: string };
}

/**
 * Ask the CLI what it offers, the way the official extension does: an `initialize`
 * control request returns its models (with effort levels and fast mode), every slash
 * command and skill, and the account. No model call, so no usage.
 */
export function describeClaude(cliPath?: string, cwd?: string): Promise<ClaudeInit | undefined> {
  const bin = resolveClaudeBinary(cliPath);
  return new Promise((resolve) => {
    let done = false;
    const proc = spawn(bin, [flag('output-format', 'stream-json'), flag('verbose'), flag('input-format', 'stream-json'), flag('model', 'haiku')], {
      cwd,
      env: buildClaudeEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const finish = (v: ClaudeInit | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      proc.kill('SIGTERM');
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), 20_000);
    proc.on('error', () => finish(undefined));
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as Json;
        if (msg.type !== 'control_response') return;
        const r = ((msg.response as Json)?.response ?? {}) as Json;
        if (!Array.isArray(r.models)) return;
        finish({ models: r.models as ClaudeInit['models'], commands: (r.commands as ClaudeInit['commands']) ?? [], account: r.account as ClaudeInit['account'] });
      } catch {
        /* not JSON */
      }
    });
    proc.stdin.on('error', () => finish(undefined));
    proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } })}\n`);
  });
}

/** The string fields of a tool's input JSON that has only partly arrived. */
export function partialInput(json: string): Record<string, string> | undefined {
  try {
    const whole = JSON.parse(json) as unknown;
    if (whole && typeof whole === 'object') return whole as Record<string, string>;
  } catch {
    /* still arriving */
  }
  const out: Record<string, string> = {};
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (!m) continue;
    try {
      out[key] = JSON.parse(`"${m[1].replace(/\\$/, '')}"`) as string;
    } catch {
      out[key] = m[1];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** One turn's cost from the CLI's running total; a total that fell means a fresh process. */
export function turnCost(total: number, base: number): number {
  return total >= base ? total - base : total;
}
