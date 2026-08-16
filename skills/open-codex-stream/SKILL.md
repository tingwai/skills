---
name: open-codex-stream
description: Open the Ting-Wai Agent Stream Herdr plugin beside the calling Codex pane and verify its live transcript viewer. Use when the user invokes $open-codex-stream or asks to open, show, restore, or start the Codex stream, transcript stream, or Agent Stream viewer in a pane to the right. Never use this skill to start another Codex agent.
---

# Open Codex Stream

Open the `tingwai.agent-stream` plugin viewer to the right of the Codex pane that invoked this skill. Preserve focus and avoid duplicate viewers. Continue to recognize the legacy `local.agent-stream` ID during migration.

## Workflow

1. Run the bundled `scripts/open_stream.mjs` with Node. Resolve the script relative to this `SKILL.md`; do not assume the user's working directory contains it.
2. Read the script's JSON result, including stdout when the command exits with status 2.
3. If the result status is `plugin_missing`, ask for permission to install the Herdr plugin. After approval, rerun the launcher with `--install`.
4. If the result status is `plugin_disabled`, ask for permission to enable the plugin. After approval, rerun the launcher with `--enable`.
5. Report whether the viewer was opened or was already open, including the returned source and viewer pane IDs.

The launcher performs all required checks: Herdr caller context, Codex session identity, plugin availability, deduplication, right-side placement, viewer process identity, and focus preservation.

## Guardrails

- Do not call `herdr agent start`; the stream viewer is a plugin pane, not a Codex agent.
- Do not create a raw pane before running the launcher; the Agent Stream plugin owns pane creation.
- Do not install or enable the plugin without user approval.
- Do not close, move, or replace an existing pane.
- Do not focus the viewer unless the user explicitly asks.
- If the launcher fails, report its error. Do not improvise a different topology or start another agent.

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
