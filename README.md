# Agent Panel

A Cursor / VS Code chat panel that runs two local CLIs in one thread:

- **Claude** — your installed Claude Code CLI (`claude`), on your Claude subscription
- **Cursor** — your installed Cursor Agent CLI (`agent`), on your Cursor subscription

Personal use only. Not published to a marketplace. The panel never stores credentials; it only starts the CLIs the way you would in a terminal.

## Install

```bash
cd agent-panel
npm install
npm run build
npm run package
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension agent-panel-0.2.0.vsix --force
```

Reload Cursor. Open the secondary sidebar **Agent Panel**, or run **Agent Panel: Open**.

## Use

1. Open a **git** workspace (Accept, Reject and Undo need git tree snapshots).
2. Under the box, pick **Claude** or **Cursor**, a model and a mode:
   - **Agent**: edits files and runs commands
   - **Plan**: reads only, then proposes a plan
   - **Hand-off**: one engine plans, the other builds, the planner can review
3. **Models** come from each tool itself: Cursor's own model catalog (the models your Cursor picker shows, then "Show more") and the Claude CLI's model list. Each row has its settings on it: an effort stepper (click a dot or drag; ←→), ⚡ fast mode and the context size where the model offers them. Changing a setting keeps the menu open; clicking the name picks it. Claude settings change inside the running session, without a restart. Note: Claude Code runs Haiku turns in Plan mode on Sonnet.
4. Type **@** for context: recent files, files and folders, code symbols, git (working changes, commits), problems, past chats, rules (AGENTS.md, CLAUDE.md, Cursor rules) and the editor selection. Arrow keys and Enter pick; picks become chips.
5. Each turn shows its steps (folded), its thinking (folded) and a card per changed file with +/− and that turn's diff. **Accept**, **Reject** and **Undo** act on the file; the bar above the box lists everything pending.
6. The header shows Claude's weekly usage. Click it for both engines: Claude's 5-hour and weekly windows with reset times, cost and tokens for this chat; Cursor's plan, account and tokens for this chat.
7. Switch engines mid-chat: the thread notes it and passes the other engine's context on.
8. Editor review: when files are pending, **Alt+F5** / **Shift+Alt+F5** move between changes, **Alt+F6** / **Shift+Alt+F6** between files, **Alt+Enter** / **Alt+Backspace** accept or reject the file. The **Review** view in the sidebar lists them too.
9. **Chat tabs**: each chat opens as its own editor tab (New chat, or any chat in history), like Cursor's; a turn keeps running in its tab while you work in another, and tabs come back after a reload. Your message stays pinned at the top while its answer scrolls.
10. **Switching engines** hands the other engine the work so far: the conversation, what was read, run and edited, the to-do list and the diff of unreviewed changes.
11. Click any attachment to open it (files, folders, symbols, git diffs, problems, past chats, images). **Add Selection to Agent Panel** (⌘⌥L or the editor's right-click menu) attaches the selection.
12. Settings: `agentPanel.claudePath`, `agentPanel.cursorPath`, `agentPanel.openEditsInEditor`. **Agent Panel: Show Log** shows turns, errors and timings.
13. **⌘.** stops a turn. Chats are saved per workspace; open them from the history button.

## Known limits

- Edits you make by hand during a turn show up in that turn's diff.
- Cursor's CLI has no plan-quota command, so the panel shows tokens per turn and links to the Cursor dashboard for quota.
- Claude's usage windows update after each Claude turn (the CLI reports them per request).
- Accept, Reject and Undo state lives in memory: after a reload, older file cards keep their diffs but lose the buttons.
- Cursor's own chats are read-only in the panel. Continuing one starts a Cursor CLI chat with the history passed along; nothing is written back to Cursor's chat list.
- Cursor turns run on the account Cursor's CLI is signed into, which can differ from the Cursor app's. The usage panel shows both and can switch the CLI's.
- Don't continue the same Claude session in the panel and the Claude Code extension at the same moment.
- Only one turn runs at a time across tabs; messages sent meanwhile wait in that tab's queue.
- Works in trusted folders only.
- Personal use only. The panel never reads or stores credentials; it starts the CLIs you are signed into.

## Develop

```bash
npm test          # parsers, models, markdown, change tracking
npm run watch     # rebuild on change
```

`qa/harness.html#agent-turn` (also `handoff`, `states`, `empty`, `pickers`; add `&theme=light&w=340`) runs the built webview against a fake host, for checking the UI against `prototype/` in a browser.
