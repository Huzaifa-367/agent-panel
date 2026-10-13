# Agent Panel: build brief

A chat panel for Cursor (and VS Code) that looks and feels like Cursor's own chat, and runs two engines in one thread:

- **Claude**: the owner's installed Claude Code CLI (`claude`, 2.1.296), signed in with the owner's Claude subscription.
- **Cursor**: the owner's installed Cursor Agent CLI (`agent`, 2026.10.01), signed in with the owner's Cursor subscription.

The panel never touches credentials. It only starts the two CLIs as child processes, unmodified, the way the owner would run them in a terminal. For the owner's personal use only; not to be published.

## Decisions (do not change without asking the owner)

| Decision | Choice |
| --- | --- |
| Location | Its own repository, `~/Documents/GitHub/agent-panel`. It started inside AiLixar and was moved out. |
| Name | "Agent Panel". Never "Claude Code" or Cursor branding (Anthropic and Cursor naming rules). |
| Modes | 1. **Switch per message**: one thread, engine picked per message. 2. **Hand-off**: one engine plans, the other builds, optionally the first reviews. |
| Not in scope | Running both engines in parallel on the same prompt. |
| Stack | TypeScript, esbuild, `@types/vscode`, `@vscode/vsce` (dev only). Webview in plain TypeScript and CSS, no UI framework. Any runtime dependency needs the owner's OK; write a small markdown renderer instead of adding one. |
| Change tracking | Git tree snapshots, the same for both engines (see below). The workspace must be a git repo; otherwise show a clear message and disable Accept/Reject. |
| Commits | Do not commit. The owner reviews and commits. Leave the uncommitted files under `nemt/` alone. |

## Engines

### Claude (aligned with Anthropic.claude-code 2.1.296, 2026-10-13)

One long-lived process per thread, started in the workspace root. Binary resolution matches the VS Code extension: `~/.cursor/extensions/anthropic.claude-code-*/resources/native-binary/claude`, else `~/.local/share/claude/versions/*`, else PATH `claude`.

```
claude --output-format=stream-json --verbose --input-format=stream-json \
  --permission-prompt-tool=stdio --setting-sources=user,project,local \
  --permission-mode=<mode> --include-partial-messages --model=<alias> \
  --enable-auth-status --no-chrome --replay-user-messages \
  [--resume=<session_id>]
```

Env (same shaping as the extension host): `CLAUDE_CODE_ENTRYPOINT=agent-panel`, drop `NODE_OPTIONS` / `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` / `TRACEPARENT` / `TRACESTATE`. No bare `-p` — the extension's ProcessTransport does not pass it.

- Send each user message as one JSON line on stdin: `{"type":"user","message":{"role":"user","content":"..."}}`.
- Models: aliases `fable`, `opus`, `sonnet`, `haiku`, or a full ID.
- Permission modes: Agent uses `acceptEdits` (faster — avoids a permission round-trip per edit; Claude Code’s interactive default is often `auto`); Plan uses `plan`. Never offer `bypassPermissions` in the UI.
- A recorded run is in `test/fixtures/claude-edit.jsonl` (an Edit of `a.txt` and a Write of `b.txt`). Event types seen:
  - `system/init`: `session_id`, `model`, `permissionMode`, `tools`, `cwd`. Store `session_id` for `--resume`.
  - `system/status`: `status: "requesting"` while waiting on the model.
  - `stream_event`: raw API stream. `content_block_start` (`text`, `tool_use` with `id` and `name`, `thinking`), `content_block_delta` (`text_delta`, `input_json_delta`, `thinking_delta`), `content_block_stop`, `message_*`. Use these for live text.
  - `assistant`: the complete message. `content[]` holds `text` and `tool_use` blocks (`id`, `name`, `input`, e.g. `Edit` with `file_path`, `old_string`, `new_string`).
  - `user`: tool results. `content[].tool_use_id`, `is_error`, plus a structured `tool_use_result` (e.g. `{"type":"create","filePath":...}`, or `stdout`/`stderr` for Bash).
  - `rate_limit_event`: `rate_limit_info.unifiedWindows.five_hour` and `.seven_day`, each with `utilization` (0 to 1) and `resetsAt` (unix seconds). Show this as a small usage meter.
  - `result`: end of the turn. `subtype` (`success` or an error), `total_cost_usd`, `usage`, `session_id`.
  - Ignore `system/hook_*` events except to log them.
- **Stopping a turn (verified 2026-10-13):** write on stdin:
  ```
  {"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}
  ```
  Reply on stdout:
  ```
  {"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"still_queued":[]}}}
  ```
  Then the CLI injects a synthetic user message with text `[Request interrupted by user]` and ends the turn with `result` / `subtype: "error_during_execution"`. Process stays alive for more stdin messages. Fallback if that ever fails: kill and `--resume <session_id>`.
- **Permission prompts (verified 2026-10-13):** `--permission-prompts host` alone is not enough in print mode — tools that need a prompt come back as `system/permission_denied` (auto-reject). Pass **`--permission-prompt-tool stdio`** as well so the host answers over stdin/stdout. With `haiku` + `--permission-mode default` + Write:
  - Outbound:
    ```
    {"type":"control_request","request_id":"<uuid>","request":{
      "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
      "input":{"file_path":"...","content":"..."},
      "description":"secret-note.txt",
      "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
      "tool_use_id":"toolu_..."
    }}
    ```
  - Allow (include `updatedInput`, usually the request's `input` unchanged):
    ```
    {"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
      "response":{"behavior":"allow","updatedInput":{...}}}}
    ```
  - Deny (include `message`):
    ```
    {"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
      "response":{"behavior":"deny","message":"User denied"}}}
    ```
  - UI mapping (same as Anthropic.claude-code): **Allow** → `behavior:allow` + `updatedInput`; **Allow for this chat** → allow with `updatedPermissions` copied from `permission_suggestions`, plus a `control_request` `set_permission_mode` / `acceptEdits`; **Deny** → `behavior:deny` + `message`. Stop uses `interrupt` with `cancel_queued: true`.

### Cursor (verified on this machine, 2026-10-13)

One process per turn, started in the workspace root:

```
agent -p --output-format stream-json --stream-partial-output --trust \
  --workspace <root> --model <id> [--resume <session_id>] [--mode plan] [--force]
  "<prompt>"
```

- Models: `agent --list-models` (e.g. `auto`, `composer-2.5`, `gpt-5.3-codex`, `claude-sonnet-5-thinking-high`). Load the list at startup and cache it. Prefer `auto` when a named model is out of usage (composer-2.5 returned `ActionRequiredError: You're out of usage` during the probe).
- Cursor's docs say print mode only proposes edits unless `--force` is passed. Agent mode passes `--force`; Plan mode passes `--mode plan` and no `--force`.
- A recorded run is in `test/fixtures/cursor-edit.jsonl` (edit of `a.txt` adding `line3`, create of `b.txt` with `hello`, model `auto`). Event types seen:
  - `system/init`: `session_id`, `model`, `cwd`, `apiKeySource`, `permissionMode`. **`session_id` is the chat ID** for `--resume <session_id>` (confirmed: a second ask-mode turn with `--resume` kept the same `session_id` and answered from prior context).
  - `user`: echo of the prompt (`message.content[]` text blocks).
  - `thinking` / `subtype: "delta"`: partial thinking text in `text`. `thinking` / `subtype: "completed"`: end of that thinking segment.
  - `assistant`: text deltas and full final text in `message.content[]` (`type: "text"`). With `--stream-partial-output`, early `assistant` lines are partial; a later one may repeat the full final string. Prefer concatenating only the growing delta form, or take the last complete `assistant` before `result`.
  - `tool_call` / `subtype: "started"` | `"completed"`: `call_id`, and `tool_call` is a one-of object whose key names the tool:
    - `globToolCall.args.globPattern`; completed `result.success.files[]`.
    - `editToolCall.args.path`, `args.streamContent` (full file body being written). Completed `result.success` has `path`, `linesAdded`, `linesRemoved`, `diffString`, optional `beforeFullFileContent` / `afterFullFileContent`, `message`.
    - (Expect other keys the same way: `readToolCall`, `shellToolCall`, `grepToolCall`, etc. — map unknown `*ToolCall` keys to a generic step title.)
  - `result` / `subtype: "success"` (or error): `duration_ms`, `is_error`, `result` (final text), `session_id`, `request_id`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). No USD cost field.

## Common event model

Both engines map into one stream the webview renders:

```ts
type AgentEvent =
  | { kind: 'session'; engine: 'claude' | 'cursor'; sessionId: string; model: string }
  | { kind: 'text'; delta: string }
  | { kind: 'thinking'; delta: string }
  | { kind: 'tool-start'; id: string; tool: string; title: string; input?: unknown }
  | { kind: 'tool-end'; id: string; ok: boolean; summary?: string }
  | { kind: 'permission'; id: string; tool: string; title: string }
  | { kind: 'usage'; fiveHour?: number; sevenDay?: number; resetsAt?: number }
  | { kind: 'done'; ok: boolean; costUsd?: number; error?: string };
```

`title` is the one-line step text: "Read `trips.spec.ts`", "Ran `git status`", "Searched for `odometer_at`", "Edited `a.txt`".

## Change tracking (engine-agnostic)

Never touch the user's index, stash, HEAD or branches.

1. Before each turn: copy `.git/index` to a temp file, then with `GIT_INDEX_FILE=<temp>` run `git add -A` and `git write-tree`. That tree ID is the turn's **base**.
2. After the turn: the same again gives the **after** tree.
3. `git diff --numstat -z <base> <after>` lists changed files with added and removed counts; `git diff <base> <after> -- <path>` gives each file's patch.
4. **Reject a file**: write back `git show <base>:<path>`, or delete the file if it is not in the base tree.
5. **Accept a file**: just clear it from the pending list.
6. Pending changes build up across turns until accepted or rejected. A file's base is the tree from before the first turn that changed it.
7. "Open diff" uses `vscode.diff` with a read-only virtual document (`agent-panel-base:` scheme) holding the base content on the left and the real file on the right.

Edits the owner makes during a turn will show up in that turn's diff. Accept that for now and note it in the README.

## Modes

- **Agent**: the selected engine with edits allowed (Claude `acceptEdits`; Cursor `--force`).
- **Plan**: read-only (Claude `--permission-mode plan`; Cursor `--mode plan`).
- **Hand-off**: pick a planner and a builder. The planner runs in Plan mode, and its plan shows as a card with **Build with <engine>** and **Edit plan** buttons. The builder then gets the plan plus the original request. An optional **Review** step sends the builder's diff back to the planner, read-only.

**Switching engines in one thread:** each engine keeps its own session. When the selected engine changes, prefix the next message with a short context block: the user messages and final assistant texts since that engine last ran, plus the list of files changed, capped at about 6,000 characters (oldest dropped first).

## UI

Direction: Cursor's chat, rebuilt with discipline. Quiet, dense, editor-native. It uses the editor's own theme, so it looks right in any Cursor theme.

- **Colors and fonts:** only `--vscode-*` theme variables (e.g. `--vscode-foreground`, `--vscode-sideBar-background`, `--vscode-input-background`, `--vscode-gitDecoration-addedResourceForeground` and `--vscode-gitDecoration-deletedResourceForeground` for +/−). UI text uses `var(--vscode-font-family)`; code and diffs use `var(--vscode-editor-font-family)`. One accent: `--vscode-focusBorder`. Spacing on a 4px scale.
- **Messages:** the user's message in a subtle bordered block. Assistant text as rendered markdown (headings, lists, code blocks with a copy button, inline code, links, tables).
- **Tool steps:** consecutive steps fold into one row ("Read 3 files · Ran 2 commands · Searched 1"), expandable to one line per step with a status dot (running, done, failed). Bash output expands under its step, collapsed by default, monospace and capped in height.
- **File edit card** (the main feature): file icon, **file name**, muted folder path, `+12` in green and `−3` in red, a chevron. Expanded: a unified diff with old and new line numbers, added and removed lines tinted, long unchanged runs collapsed ("⋯ 24 unchanged lines"). Buttons: **Accept**, **Reject**, **Open diff**. Clicking the name opens the file.
- **Changes bar** above the input whenever changes are pending: "3 files changed +40 −12" (expandable list), **Accept all**, **Reject all**.
- **Composer:** auto-growing textarea, Enter sends and Shift+Enter adds a new line. A row under it holds the engine pill (Claude or Cursor), the model dropdown for that engine, the mode dropdown (Agent, Plan, Hand-off), `@` file mentions (fuzzy search over workspace files), and a send button that turns into stop while a turn runs.
- **Header:** thread title (the first message, cut short), new chat, history list (threads saved per workspace in `workspaceState`), the Claude usage meter ("Week 88% · resets Thu 9:00").
- **Permission prompt** (once the Claude host mode works): inline on the step, with **Allow**, **Allow for this chat** and **Deny**.
- **Hard no:** gradients, glass effects, emoji as icons, shadows on every element, centered layouts, filler copy. Use `codicon` icons from VS Code.
- The view sits in Cursor's secondary sidebar. There is also a command to open it as an editor tab.

## File layout

```
agent-panel/
  package.json            extension manifest and scripts
  esbuild.mjs             builds the extension, the webview and the tests; joins the stylesheets
  src/
    extension.ts          activation, view provider, turns, hand-off, settings, saved chats
    engines/claude.ts     long-lived Claude process, stdin writer, event mapping, effort
    engines/cursor.ts     Cursor process per turn, binary lookup, model catalog, event mapping
    engines/types.ts      AgentEvent, engine interface, step titles
    models.ts             model catalogs grouped like Cursor's picker (family, base, variants)
    usage.ts              Claude 5-hour and weekly windows, Cursor plan, per-turn tokens
    mentions.ts           the @ menu: recent, files, folders, code, git, problems, chats, rules, selection
    changes.ts            git tree snapshots, per-turn diffs, accept, reject, undo
    review.ts, diff_hunks.ts  in-editor review: highlights, next change, tree, CodeLens
    threads.ts            chat records (steps, thinking, files, model, cost) and hand-over context
    handoff.ts            planner, builder and reviewer prompts
  webview/
    main.ts               shell and host messages; regions update on their own
    store.ts, dom.ts      state and DOM helpers
    header.ts             header, usage popover, chat history
    thread.ts             messages, thinking, steps, permission prompts, errors, plan card
    files.ts              file cards, diffs, changes bar
    composer.ts           composer, engine switch, pickers, hand-off row
    modelpicker.ts        grouped model menu with search, effort, thinking and fast
    mentionmenu.ts        grouped @ popover with keyboard control
    markdown.ts           markdown renderer
    styles/*.css          tokens, base, thread, steps, file-card, composer, plan, panel
  prototype/              the visual spec, one page per state
  qa/                     harness that runs the built webview against fake-host scenarios
  test/                   node:test suites and recorded CLI output
```

## Build order

1. Record the Cursor stream (see above) and probe Claude's interrupt and permission messages. Update this file.
2. Extension skeleton, webview, Claude engine, streaming chat with tool steps.
3. Change tracking, file cards, changes bar, Accept/Reject, Open diff.
4. Cursor engine, engine and model pickers, switching with the context block.
5. Plan mode and Hand-off.
6. History, usage meter, `@` mentions, permission prompts, polish.
7. Package with `npx @vscode/vsce package`, install with `/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension agent-panel/<file>.vsix`, and test in Cursor.

## Done when

- Tests pass: both engine parsers against their fixtures, and change tracking in a temp git repo (edit, new file, deleted file, reject restores each one).
- In Cursor, in a scratch git repo: a Claude turn and a Cursor turn each edit a file and create one. Both show file cards with correct +/− counts, and Accept and Reject both work.
- Switching engine mid-thread passes context: the second engine can answer "what did we just change?".
- Hand-off: Claude plans, Cursor builds, the plan card and the resulting file cards both show.
- No uncaught errors in the extension host log after these runs.
- `README.md` covers install, use and the known limits.

## Progress

| Step | Status |
| --- | --- |
| Claude and Cursor streams recorded | Done (2026-10-13), `test/fixtures/` |
| 1–7 first build (by Cursor) | Done, 0.1.0 |
| Rework to the prototype and full feature pass | Done (2026-10-13), 0.2.0 |
| Research pass against the official Claude Code panel and Cursor's chat | Done (2026-10-13), 0.4.0 |
| Cursor-style timeline, tabs, hand-over, production basics | Done (2026-10-13), 0.5.0 |
| Models, effort and context from each tool (MODELS-PLAN.md); chats as editor tabs | Done (2026-10-13), 0.6.0 installed in Cursor |

What 0.2.0 covers:

- Models grouped like Cursor's picker: search, Auto, families, each base model with effort, thinking and fast variants (256 Cursor model ids: Auto plus 255 variants under 44 base models). Claude models with an effort setting (`--effort`). Each engine keeps its own model.
- Usage for both engines: Claude's 5-hour and weekly windows with reset times, cost and tokens per turn and per chat; Cursor's plan tier and account, tokens per turn and per chat. Cursor's CLI has no quota command, so plan quota links to the dashboard.
- The @ menu grouped like Cursor's: Recent, Files & folders, Code, Git (working changes, commits), Problems, Past chats, Rules, Selection. Picks become chips and are sent as context.
- Chats keep their steps, thinking, per-turn files, model, timing and cost when reopened. File cards sit under the turn that made them, show that turn's own diff, and Accept, Reject and Undo act on the file.
- Thinking folds, engine-switch notes, plan cards with edit and build, review after build, retry and sign-in actions on errors, a no-git banner, ⌘. to stop.
- The composer is built once, so typing and focus survive streaming.

Checked: 22 unit tests; 24 scripted behaviour checks and screenshots of every prototype state in both themes at 340 and 420 px (`qa/`); a real Claude turn and a real Cursor turn through the engines on a scratch repo.

0.4.0 adds, after comparing with both official panels: queued follow-ups, restore checkpoint and edit-and-resend on each message, an Ask-first mode, Claude slash commands, pasted or dropped images, a context meter with compact, to-do lists, clickable file paths, markdown while streaming, syntax colours from the theme, Claude Code sessions and Cursor chats in history (Claude sessions continue under the same id and sync live), both Cursor accounts in the usage panel, and live in-editor highlights diffed from the editor's text (added, modified, removed with hover). Faster: one git diff per base instead of per file, a cached snapshot, `git ls-files` for @, Cursor models cached across restarts, minified builds, off-screen turns skipped by the browser. Stack kept: plain TypeScript and esbuild (53 KB webview against the official panel's 5.5 MB React bundle).

Not checked: clicking through the installed extension inside Cursor itself.
