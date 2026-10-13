# Changelog

## 0.7.0

First public release.

### Fixed

- **Reject, Undo and Restore checkpoint could delete a file that existed in the base.** A failed `git show` was treated as "the file is not in the base tree". Now git must confirm the path is absent (`git ls-tree`); any other failure aborts and leaves the file alone. Paths are also refused if they leave the workspace.
- **A Claude or Cursor process that died without a non-zero exit code left the turn "running" for 30 minutes** (killed by a signal, or a clean exit mid-turn). Every exit now ends the turn. Cursor exit handling waits for stdout to drain, and Stop escalates to SIGKILL after 3 s.
- A second message sent while a turn was still starting (snapshot, `@` context) could start a concurrent turn. It now queues.
- A thrown error during a turn no longer leaves Stop showing and the queue stuck.
- The 30-minute turn limit is now an inactivity limit, so long turns that keep working are not killed.
- A failed Build no longer marks the plan "built"; it can be retried.
- A dangling symlink in a skills or commands folder no longer blanks the panel.
- Writing to a dead Claude process (EPIPE) no longer raises an unhandled error.
- **Alt+Backspace and Alt+Enter** no longer reject or accept a file when the focused editor is an unrelated file; rejecting from a keybinding asks first.
- Streaming text could print twice when a state update landed between buffered deltas.
- Markdown: underscores in a link address (`a__b__c`) no longer break the link; links show their real target on hover; absurd nesting no longer breaks the thread.
- Diff cards dropped removed lines that began with `-- ` (SQL, Lua comments) and mis-numbered the rest.
- Restore, Retry and Build buttons on older messages could be stale after a turn.
- Enter on a history row's Delete button also opened the chat; Enter inside an IME composition could send or pick a menu row; Undo could not be pressed from the keyboard; **⌘.** could stop another chat's turn.
- Borders disappeared in themes that do not define `widget-border`.
- A prompt starting with `/` that is not a command (for example a file path) is no longer sent as a slash command; Cursor prompts that start with `-` are no longer read as options.
- Mentions and `getPatch` validate what they pass to `git` and refuse paths outside the workspace.

### Changed

- Child CLI processes are ended when a chat tab is closed, a chat is deleted, or the extension deactivates.
- `agentPanel.claudePath` and `agentPanel.cursorPath` are machine-scoped.
- Review commands appear in the Command Palette only while there is something to review.
- The webview content security policy drops remote images and adds `base-uri` and `form-action`.

### Added

- **An activity-bar entry.** Agent Panel is listed with Explorer, Search and the rest; choosing it opens the chat in the secondary sidebar.
- **A fixed space of its own for chats, like Cursor's.** Chats are tabs in the Agent Panel sidebar and nothing else opens there; the Review list moved to the Explorer and shows only while there is something to review. `agentPanel.chatLocation: editor` keeps chats as editor tabs, all in one locked editor group.
- Public documentation: README with screenshots, architecture notes, contributing and security guides, MIT license.

## 0.6.x and earlier

Private builds: Claude and Cursor engines, per-file review, hand-off, model picker with effort and fast mode, `@` context, usage meters, chat tabs, queued follow-ups. See `docs/design/` for the design record.
