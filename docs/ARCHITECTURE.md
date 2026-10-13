# Architecture

Agent Panel has three parts: an **extension host** that owns processes, git and state, a **webview** that renders the thread, and **two engines** that adapt the Claude and Cursor CLIs to one event model.

```
agent-panel/
  package.json            manifest, commands, keybindings, settings
  esbuild.mjs             builds extension, webview and tests; joins the stylesheets
  src/                    extension host (Node)
    extension.ts          activation, view and tab providers, turns, queue, hand-off, saved chats
    engines/types.ts      AgentEvent, the Engine interface, step titles
    engines/claude.ts     one long-lived `claude` process per chat, stdin protocol, event mapping
    engines/cursor.ts     one `agent` process per turn, binary lookup, model catalog, event mapping
    changes.ts            git tree snapshots, per-turn diffs, accept, reject, undo, restore
    review.ts, diff_hunks.ts, linediff.ts, editdiff.ts   in-editor review: highlights, CodeLens, next change
    threads.ts            chat records and the hand-over built when the engine switches
    handoff.ts            planner, builder and reviewer prompts
    mentions.ts           the @ menu and how a pick becomes prompt context
    models.ts, cursorCatalog.ts   model catalogs, effort / fast / context variants
    usage.ts              Claude windows, Cursor plan and account, tokens
    external.ts           Claude Code sessions and Cursor chats shown in history
    commands.ts           slash commands and skills
  webview/                the UI (browser, no framework)
    main.ts, store.ts, dom.ts      shell, state, DOM helpers
    thread.ts, header.ts, composer.ts, files.ts, modelpicker.ts, mentionmenu.ts, markdown.ts, highlight.ts
    styles/*.css          tokens, base, thread, steps, file-card, composer, plan, panel
  test/                   node:test suites and recorded CLI output (test/fixtures)
  qa/                     browser harness with a fake host, used for screenshots
  prototype/              the static design spec, one page per state
  docs/design/            historical design records
```

## One event model

Both engines emit `AgentEvent`s: `session`, `text`, `thinking`, `tool-start`, `tool-end`, `permission`, `usage` and `done`. The host turns them into a `ChatMessage` (text, ordered parts, steps) and posts it to the webview. Neither the host's turn code nor the UI branches on the engine except for settings that only one engine has.

### Claude

The panel starts `claude --output-format=stream-json --input-format=stream-json --permission-prompt-tool=stdio --include-partial-messages …` once per chat and keeps it warm. A user message is one JSON line on stdin. Interrupt, permission answers, model, effort and permission-mode changes are `control_request` messages on the same pipe, so changing a model needs no restart. `--resume <session_id>` continues a session. Permission modes map as: Agent → `acceptEdits`, Ask first → `default`, Plan → `plan`, Auto → `bypassPermissions`.

### Cursor

`agent -p --output-format stream-json --stream-partial-output --trust --workspace <root> --model <id> [--resume <id>] [--mode plan | --force] -- "<prompt>"`, one process per turn. Tool calls arrive as `*ToolCall` objects and are mapped to the same steps. Models take the CLI's parameterised form, `id[context=…,effort=…,fast=…]`.

Parsers are tested against recorded streams in `test/fixtures/`.

## Turn lifecycle

1. `send` arrives from the webview. If a turn is running or starting, the message joins that tab's queue.
2. `@` mentions are resolved to context; images are saved to disk.
3. If the engine changed since the last turn, a hand-over (messages, steps, to-dos, unreviewed diff) is prepended.
4. `ChangeTracker.snapshotTree()` records the **base tree**.
5. The engine starts; events stream to the webview (text deltas are batched about every 32 ms).
6. When the engine ends (result, error, stop, process exit or 30 minutes without output), the host snapshots the **after tree**, diffs the two, and attaches per-file cards to the message.
7. The message is saved, `turn-done` is posted, and the queue drains.

## Change tracking

All through `git`, never touching your index, stash, HEAD or branches:

1. Copy `.git/index` to a temp file; with `GIT_INDEX_FILE=<temp>` run `git add -A` and `git write-tree`. The tree id is a snapshot.
2. `git diff --numstat -z <base> <after>` lists changes; `git diff <base> <after> -- <path>` gives a file's patch.
3. **Reject** writes the file back from the base tree, or deletes it if git confirms the base has no such file. A git failure aborts without touching the file.
4. **Accept** clears the file from the pending list. **Undo** re-applies an Accept or a Reject.
5. A file's base is the tree from before the first turn that changed it, so pending changes accumulate across turns.
6. **Restore checkpoint** puts a message's files back to the tree from before it, leaving the chat alone.
7. Every path is resolved against the workspace root and refused if it leaves it.

## Webview

One `store` holds host state. Regions (header, thread, changes bar, composer) update independently, so the composer keeps focus and the thread keeps its scroll while a turn streams. Messages are rebuilt only when their signature changes. All model- and file-derived text is escaped before `innerHTML` or set with `textContent`. The markdown renderer is about 180 lines and supports headings, lists, tables, quotes, code blocks with highlighting and a copy button, inline code (file paths are clickable) and `https:` links.

## Theming

Components read only `--ap-*` tokens, mapped from `--vscode-*` variables in `webview/styles/tokens.css`. No hard-coded colours in components.
