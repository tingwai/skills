---
name: open-codex-stream
description: Open or restore the Ting-Wai Codex Stream browser or terminal viewer beside the calling Codex pane in Cmux, or its terminal viewer in Herdr. Use when the user invokes $open-codex-stream or asks to open, show, restore, or start the Codex stream, transcript stream, or Agent Stream viewer in a pane to the right. Never use this skill to start another Codex agent.
---

# Open Codex Stream

Open the transcript viewer to the right of the Codex pane that invoked this skill. Preserve focus, avoid duplicate viewers, and associate it with the calling Codex surface/session. Automatic Cmux sessions use the native browser viewer. Manual invocation supports both browser and terminal modes. Herdr continues to use the terminal `tingwai.agent-stream` plugin and recognizes the legacy `local.agent-stream` ID during migration.

## Mode contract

- In Cmux, an unqualified `$open-codex-stream` or “open the Codex stream” request defaults to the browser viewer. Run `scripts/open_stream.mjs`; it opens immediately, including before a transcript exists, and attaches in place later.
- If the user explicitly asks for the browser or web stream in Cmux, run `scripts/open_stream.mjs --browser`.
- If the user explicitly asks for the terminal or TUI stream, run `scripts/open_stream.mjs --terminal`.
- In Herdr, an unqualified request defaults to its terminal viewer. Browser mode is unsupported there; if explicitly requested, report that boundary and offer terminal mode rather than falling back silently.

## Workflow

1. Select browser or terminal mode using the contract above, then run the bundled `scripts/open_stream.mjs` with Node and the corresponding flag. Resolve the script relative to this `SKILL.md`; do not assume the user's working directory contains it.
2. Read the script's JSON result, including stdout when the command exits with status 2.
3. In Herdr, if the result status is `plugin_missing`, ask for permission to install the plugin. After approval, rerun the launcher with `--install`.
4. In Herdr, if the result status is `plugin_disabled`, ask for permission to enable it. After approval, rerun the launcher with `--enable`.
5. Report whether the viewer was opened, restored, pending, or already open, including the returned runtime and source/viewer IDs.

The dispatcher and launchers perform the runtime-specific checks, session lookup, deduplication, right-side placement, viewer process identity, and focus preservation. Cmux session identity comes from Cmux's native Codex hook registry and exact-surface events rather than working-directory guesses.

The Cmux viewer claims an alternate screen before it waits for session metadata, hiding the shell prompt and launch command while showing the same framed `Nothing to display yet.` state as Herdr. Lowercase `q` closes the dedicated Cmux viewer surface; the same key in Herdr only exits the TUI as before.

## Automatic Cmux browser launch

The user's zsh configuration sources `scripts/codex_auto_start.zsh`. Its `codex` wrapper directly starts `scripts/open_web_stream_cmux.mjs --auto` in the background only for session-producing Codex commands inside Cmux, then delegates to the Codex executable already selected by `PATH`. The launcher immediately starts a localhost-only, source-surface-scoped SSE server and opens or restores an unfocused browser pane to the right, even before Cmux registers a transcript. The empty pane shows `Nothing to display yet.` until the server observes an authoritative session for that exact surface. An in-session `/resume` resets the same browser pane to the resumed transcript rather than mixing histories or opening another pane. Outside Cmux the wrapper delegates immediately without launching or changing anything.

The wrapper invokes Node as internal function logic; it never sends or pastes a launcher command into an interactive terminal, so the side-pane command does not enter zsh history. Automatic errors are non-fatal and are written to `~/.cmuxterm/agent-stream-web/auto-<surface-id>.log`.

## Guardrails

- Do not start another Codex agent; the stream is only a transcript viewer.
- Do not create a raw pane before running the launcher; the launcher owns pane creation.
- Do not install or enable the plugin without user approval.
- Do not close, move, or replace an existing pane.
- Do not focus the viewer unless the user explicitly asks.
- If the launcher fails, report its error. Do not improvise a different topology or start another agent.
- Outside Cmux and Herdr, report that the launcher needs one of those managed terminal environments. Do not change the current session.

## Command

```bash
node <skill-directory>/scripts/open_stream.mjs
```

Explicit browser mode in Cmux:

```bash
node <skill-directory>/scripts/open_stream.mjs --browser
```

Explicit terminal mode in Cmux or Herdr:

```bash
node <skill-directory>/scripts/open_stream.mjs --terminal
```

After approval for first-time installation:

```bash
node <skill-directory>/scripts/open_stream.mjs --install
```

After approval to re-enable an installed plugin:

```bash
node <skill-directory>/scripts/open_stream.mjs --enable
```

## Cmux browser viewer

The dispatcher command above is preferred. The underlying automatic browser launcher remains available for diagnostics:

```bash
node <skill-directory>/scripts/open_web_stream_cmux.mjs
```

It opens or restores an unfocused native browser pane to the right and attaches it to the calling Cmux surface's Codex session when that session becomes available. It deduplicates by source surface and stops orphaned servers when pane creation fails or after the browser disconnects. Report the returned status, URL, surface ID, server PID, and log path.

Use `scripts/open_stream.mjs --terminal` when the user explicitly wants the terminal viewer fallback. Keep Herdr on its established plugin path.
