# Models, effort and context: research and plan

**Status: built in 0.6.0.** Verified on this Mac: the bracket model form runs in Cursor's CLI (`claude-opus-5-5[context=300k,effort=low,fast=false]` → "Claude Opus 5.5 300K Low"), and a live `set_model` switched one warm Claude process from Haiku 5.5 to Sonnet 5.5 between turns with no restart (Agent mode; in Plan mode Claude Code answers Haiku turns with Sonnet).

Researched 2026-10-13 on this Mac: Cursor 2026.10 (app and `agent` CLI 2026.10.01), Claude Code 2.1.296 (CLI and the official extension). Nothing here writes to Cursor's or Claude's own files; everything is read-only.

## What we found

### Why the panel shows only a few Cursor models

1. **Cursor's CLI is signed out.** `agent status` says "Not logged in", so `agent --list-models` returns nothing. The CLI keeps its own sign-in, separate from the app's.
2. **A bug in the panel made it worse.** When the CLI returns nothing, the panel falls back to a built-in list of 4 models and saves that list over the good cached one (`extension.ts`, the `catalog(true)` callback). The full list is lost until the CLI answers again.

Until the CLI is signed in again, Cursor turns in the panel will also fail.

### How Cursor's own picker works

Cursor keeps its whole model catalog locally, in its settings store (`state.vscdb`, `ItemTable`, key `src.vs.platform.reactivestorage…applicationUser`):

- `availableDefaultModels2`: 44 models. Each has:
  - `serverModelName`, `clientDisplayName`, `inputboxShortModelName`
  - `namedModelSectionIndex`: which section it sits in (Cursor Models or Other Models)
  - `tooltipData.markdownContent`: the hover card ("Claude Opus 5.5 · Anthropic's large model class… · 300k context window · Version: medium effort")
  - `contextTokenLimit`, `contextTokenLimitForMaxMode`, `supportsThinking`, `supportsImages`, `supportsMaxMode`, `modelPickerBadges` ("New")
  - `parameterDefinitions`: the settings a model takes, each with its allowed values:
    - `context`: for example `300k` or `1m` (marked "increases model cost")
    - `effort` (or `reasoning_effort` / `reasoning` on some models): low, medium, high, xhigh, max
    - `fast`: on or off ("2x more expensive, but significantly faster")
  - `variants`: every allowed combination, with its display name ("Claude Opus 5.5 Low")
- `aiSettings.modelOverrideEnabled`: the models you switched on for the picker. This is why Cursor shows a short list while the CLI lists 256 ids.
- `aiSettings.modelParameterPreferences`: the settings you last chose per model (for example Grok 4.6 at medium effort, fast on).
- `aiSettings.modelConfig.composer`: the chat's current model and settings.

The CLI takes the same settings as one parameterised id (from `agent --help`): `--model 'claude-opus-4-8[context=1m,effort=high,fast=false]'`. So the picker can offer exactly what Cursor offers, and pass it straight to the CLI.

### How the official Claude Code extension works

- The Claude CLI answers an `initialize` control request (no model call, no cost) with:
  - `models`: 13 entries, each with `value` (the alias to pass), `displayName`, `description`, `resolvedModel`, `supportedEffortLevels`, `supportsFastMode`, `supportsAdaptiveThinking`. For example "Default (recommended): Opus 5.5 · Best for everyday, complex tasks", Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5, then older versions.
  - `commands`: 142 slash commands and skills, each with `description`, `aliases`, `argumentHint`.
  - `account`: email, organisation, `subscriptionType: "Claude Max"`.
- The extension changes settings **inside the running session**, without restarting the CLI:
  - `set_model` `{model}`
  - `apply_flag_settings` `{settings: {effortLevel, fastMode, alwaysThinkingEnabled, …}}`
  - `set_max_thinking_tokens`
  - `set_permission_mode`
- Its effort control is a slider ("Click or drag to set effort level"); fast mode is a toggle ("Opus only"); thinking is a toggle.
- The context window isn't a choice for Claude: each turn's result reports it (`modelUsage.<model>.contextWindow`, 1M for current models).

### What the panel does today

- Claude models are a hard-coded list of 4 aliases; effort is a row of buttons under the model.
- Changing a Claude model or effort restarts the CLI (a cold start each time).
- Cursor variants are reverse-engineered from the CLI's flat id list. Context size isn't offered. The section split is a name guess.
- `/` commands come from scanning skill and command files.

## Design

### The picker

- **One row per model, everything on that row:** `[name] [effort stepper] [fast ⚡] [context chip] [✓]`.
- **Effort stepper:** a small track with one dot per allowed level and a knob on the chosen one, as in the Claude extension's slider. Click a dot or drag the knob. The left and right arrow keys change effort on the highlighted row. Hovering it shows the level name.
- **Fast mode:** ⚡ appears only on models that support it, and it's lit when on. Hovering shows the cost note.
- **Context chip:** appears only when a model offers more than one size, for example `300K | 1M`, with "costs more" on hover.
- **Rows keep their settings:** a row shows that model's own last-used settings, so picking it restores them, as in Cursor.
- **Sections:**
  - Cursor: Auto, then Cursor Models, then Other Models, using Cursor's own section numbers. Only the models you switched on in Cursor are shown, followed by "Show N more models".
  - Claude: Default (recommended), then the current models, then "Older models".
- **Hover card:** the model's description, its context window and the chosen settings, taken from Cursor's tooltip text and Claude's descriptions.
- **Composer button:** shows the short form, for example `Opus 5.5 · High ⚡`.
- **Sign-in states:** when Cursor's CLI is signed out, the picker shows a banner "Cursor's CLI is signed out" with a **Sign in** button (runs `agent login`), instead of silently showing a short list.

### Where the data comes from

| | Primary | Fallback |
| --- | --- | --- |
| Cursor models, sections, descriptions, settings | Cursor's local catalog (read-only) | `agent --list-models`, then the last good cache, never the 4-model stub |
| Which Cursor models show | Your Cursor picker's switched-on list | All |
| Cursor per-model last settings | Your Cursor preferences | Cursor's defaults |
| Claude models and effort levels | The CLI's `initialize` reply | Last good cache |
| Claude `/` commands | `initialize` (142, with descriptions) | The file scan we have now |
| Claude account | `initialize` | — |

### Running a turn

- **Cursor:** build `--model base[context=…,effort=…,fast=…]` from the chosen settings, using each model's own setting ids (`effort`, `reasoning_effort` or `reasoning`). Legacy flat ids keep working.
- **Claude:**
  - Keep the warm process and send `set_model` and `apply_flag_settings` (effort, fast mode, thinking) before the turn, instead of restarting it.
  - Fall back to a restart with `--effort max` only if `max` isn't accepted live (the settings schema lists effort only up to `xhigh`).

## Steps

1. **Fix the short Cursor list.**
   - `extension.ts`: never let the fallback overwrite the cached catalog. Mark fallback lists, show the sign-in banner, refresh after `agent login`.
   - Test: the fallback never replaces a real cache.
2. **Cursor catalog from Cursor itself.**
   - New `src/cursorCatalog.ts`: read `availableDefaultModels2`, `modelOverrideEnabled`, `modelParameterPreferences` and `modelConfig.composer` with one read-only `sqlite3` query (the same pattern as the account read).
   - Turn each entry into a model with its parameter definitions, sections, tooltip and badges.
   - Merge with `agent --list-models` so models the CLI can't run are hidden.
   - Test: a trimmed fixture of the catalog.
3. **Claude catalog from `initialize`.**
   - `engines/claude.ts`: send `initialize` once on the warm process, read `models`, `commands` and `account`, and cache them.
   - Add `setModel` and `applyFlagSettings`.
   - Replace `CLAUDE_MODELS` and the `/` file scan.
   - Test: a recorded `initialize` reply as a fixture.
4. **One model shape for both engines.**
   - `models.ts`: `{ id, label, description, section, params: [{ id, kind: 'enum' | 'bool', values, default, costly }], badges }`, plus the selection as `{ model, params }`.
   - `toCliModel()` builds the Cursor string; the Claude side maps settings to flags and live settings.
   - Thread and prefs store `{ model, params }` per engine (older saves keep working).
5. **Live Claude settings.**
   - `engines/claude.ts`: on a new turn, compare the wanted model and settings with the process's, and send `set_model` / `apply_flag_settings` instead of killing it.
   - Measure: the process id stays the same and there's no cold start.
6. **The picker UI.**
   - `webview/modelpicker.ts`: rows with the stepper, ⚡ and context chip; sections; "Show N more"; hover card; keyboard (↑↓ move, ←→ effort, F fast, Enter pick).
   - `styles/panel.css`: the stepper (track, dots, knob, focus ring), chips, hover card. Every colour from the theme.
   - Composer button label.
7. **Usage panel:** Claude plan name ("Claude Max") from `initialize`.
8. **Checks.**
   - Unit tests for each parser and the id builder.
   - Harness scenarios for both pickers (signed in and signed out), with screenshots at 340 and 420 px.
   - One real Cursor turn with `claude-opus-5-5[context=300k,effort=low,fast=false]` after sign-in.
   - One real Claude turn switching effort live.

## To verify while building

- The exact setting names the CLI accepts in brackets for every model. The help shows `context`, `effort`, `fast`; Cursor's catalog uses `reasoning_effort` and `reasoning` on some models. Needs one real call each after the CLI is signed in.
- Whether `apply_flag_settings` accepts `effortLevel: "max"`.
- Whether turning thinking off via `alwaysThinkingEnabled` takes effect mid-session.

## Not possible

- Cursor's per-pool usage ("Cursor Models: 2% used") isn't stored locally; Cursor fetches it with your sign-in, which the panel won't use.
- Writing your picks back into Cursor's own picker: that store belongs to the running app.

## Before building

Sign Cursor's CLI back in: run `agent login` in a terminal, or use **Sign in** in the panel's usage popover. Without it, Cursor turns and the full model list don't work.
