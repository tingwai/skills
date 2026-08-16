# Ting-Wai's Skills

Small, focused skills for coding agents.

## Install in Claude Code

```text
/plugin marketplace add tingwai/skills
/plugin install html-that@tingwai
/plugin install open-codex-stream@tingwai
```

## Install in Codex and other agents

```sh
npx skills@latest add tingwai/skills
```

## Included skills

- `html-that` — Render Markdown in a self-contained HTML reading page and open it in the default browser. Install it with `html-that@tingwai`.
- `open-codex-stream` — Open the live Codex transcript viewer in a right-hand Herdr pane. Install the Herdr plugin with `herdr plugin install tingwai/skills/herdr-plugins/agent-stream`.

## Herdr plugins

- `tingwai.agent-stream` — Continuously display Codex transcript events beside their source panes.

```sh
herdr plugin install tingwai/skills/herdr-plugins/agent-stream
```
