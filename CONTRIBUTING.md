# Contributing

Thanks for helping. Agent Panel is small on purpose: plain TypeScript, esbuild, no UI framework, no runtime dependencies beyond the Codicons font.

## Set up

```bash
npm install
npm test            # build + unit tests; must pass
npm run watch       # rebuild on change
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host. You need at least one of the `claude` or `agent` CLIs signed in to run turns.

## Check the UI without an editor

`qa/harness.html` runs the built webview against a fake host (`qa/scenarios.js`). Open `qa/harness.html#agent-turn&theme=light&w=340` in a browser after `npm run build`. Scenarios: `agent-turn`, `handoff`, `states`, `empty`, `pickers`. Add `&click=<selector>~<selector>` to open menus. Check every UI change at 340 px wide, in a light theme and in a dark one.

## Layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short: `src/` is the extension host, `webview/` is the UI, `test/` has `node:test` suites with recorded CLI output in `test/fixtures/`.

## Pull requests

- One change per PR; say what it fixes and how you checked it.
- Add or update a test when you touch a parser, change tracking, or markdown rendering. A recorded CLI stream in `test/fixtures/` is the best test for an engine change.
- UI: colours and fonts only from `--ap-*` tokens (`webview/styles/tokens.css`), icons from Codicons, no modals or toasts, errors stay in the thread.
- Anything that deletes or overwrites user files needs a test showing it cannot do so on a git failure.
- Keep the style of the surrounding code: short comments that explain why.

## Things we would like help with

- Windows and Linux: binary lookup, Cursor's local data paths, `.cmd` shims.
- Multi-root workspaces and repositories where the workspace is a subfolder.
- Persisting pending review state across reloads.
- Per-hunk Accept and Reject.
- Keyboard navigation inside popovers.
