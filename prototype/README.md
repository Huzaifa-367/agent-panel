# Agent Panel UI prototype

The visual spec for the Agent Panel webview. Match it state by state. Where it differs from the UI section of `../PLAN.md`, the prototype wins.

## View it

Open `index.html` in a browser. The pages load codicons from jsDelivr, so they need a network connection. The toolbar switches dark/light and the panel width (340, 420, 560 px).

## Pages

| Page | Shows |
| --- | --- |
| `agent-turn.html` | Tool step groups, command output, file cards (new, edited, accepted), diffs with folded lines, the changes bar, an engine switch note, a running turn with stop |
| `handoff.html` | Hand-off row in the composer, plan card, hand-over notes, builder turn, review findings |
| `states.html` | Inline permission prompt, denied step, engine errors, no-git banner |
| `empty.html` | Empty thread, recent threads, disabled send |
| `pickers.html` | Engine switch, model and mode menus, @ file popover, chips, markdown table and code block |

## Files

| File | Role | Into the extension? |
| --- | --- | --- |
| `css/tokens.css` | `--ap-*` tokens mapped from the editor's `--vscode-*` theme variables | The `--ap-*` block only. Drop the `--vscode-*` values: the editor injects the real ones. |
| `css/base.css` | Panel shell, buttons, engine tags, chips, spinner | Yes |
| `css/thread.css` | Header, usage meter, messages, markdown, notes, alerts, empty state, history | Yes |
| `css/steps.css` | Tool step groups, output, permission prompt | Yes |
| `css/file-card.css` | File cards and the unified diff | Yes |
| `css/composer.css` | Changes bar, composer, pickers, menus, @ popover | Yes |
| `css/plan.css` | Plan card and review list | Yes |
| `css/preview.css` | The page around the panel | No |
| `js/menus.js` | Model and mode menus. The model lists are examples: load Cursor's from `agent --list-models` | Behaviour only |
| `js/prototype.js` | Every interaction: open/close, accept/reject/undo, changes bar totals, engine switch, menus, @ mentions, permission answers | Behaviour only |

Everything inside `<!-- the webview starts here -->` is the webview's markup. Keep the class names (`ap-*`) so the CSS carries over unchanged.

## Rules

- Colours, fonts and borders come only from `--ap-*` tokens. No hard-coded colours in components.
- Icons are codicons. Bundle `@vscode/codicons` (`codicon.css` and `codicon.ttf`) with the webview; it is a build-time asset, not a runtime library,.
- Accept and Reject act per file; Accept all and Reject all act on every pending file in the thread. The changes bar totals only count pending files and hide when there are none.
- A running step group stays open; a finished one folds to its summary.
- Errors and permission prompts stay in the thread where they happened. No modals, no toasts.
- Check every state at 340 px wide and in a light theme.
