---
name: open-codex-stream
description: Open or restore the Ting-Wai Codex Stream viewer beside the calling Codex pane in Cmux or Herdr. Use when the user invokes $open-codex-stream or asks to open, show, restore, or start the Codex stream, transcript stream, or Agent Stream viewer in a pane to the right. Never use this skill to start another Codex agent.
---

# Open Codex Stream

Open the transcript viewer to the right of the Codex pane that invoked this skill. Preserve focus, avoid duplicate viewers, and associate it with the calling Codex session. Use Cmux's native split API in Cmux and the `tingwai.agent-stream` plugin in Herdr. Continue to recognize the legacy `local.agent-stream` Herdr ID during migration.

## Workflow

1. Run the bundled `scripts/open_stream.mjs` with Node. Resolve the script relative to this `SKILL.md`; do not assume the user's working directory contains it.
2. Read the script's JSON result, including stdout when the command exits with status 2.
3. In Herdr, if the result status is `plugin_missing`, ask for permission to install the plugin. After approval, rerun the launcher with `--install`.
4. In Herdr, if the result status is `plugin_disabled`, ask for permission to enable it. After approval, rerun the launcher with `--enable`.
5. Report whether the viewer was opened, restored, pending, or already open, including the returned runtime and source/viewer IDs.

The launcher performs the runtime-specific checks, session lookup, deduplication, right-side placement, viewer process identity, and focus preservation. Cmux session identity comes from Cmux's native Codex hook registry rather than transcript timestamps or working-directory guesses.

The Cmux viewer claims an alternate screen before it waits for session metadata, hiding the shell prompt and launch command while showing the same framed `Nothing to display yet.` state as Herdr. Lowercase `q` closes the dedicated Cmux viewer surface; the same key in Herdr only exits the TUI as before.

## Automatic Cmux launch

The user's zsh configuration sources `scripts/codex_auto_start.zsh`. Its `codex` wrapper starts this launcher in the background only for session-producing Codex commands inside Cmux, then delegates to the Codex executable already selected by `PATH`. Outside Cmux it delegates immediately without launching or changing anything.

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

After approval for first-time installation:

```bash
node <skill-directory>/scripts/open_stream.mjs --install
```

After approval to re-enable an installed plugin:

```bash
node <skill-directory>/scripts/open_stream.mjs --enable
```
