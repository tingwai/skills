# Herdr Agent Stream

This local Herdr plugin opens a right-hand split for each Codex session and
continuously renders completed transcript events. It uses the Codex transcript
as the source because Herdr's pane API only exposes terminal snapshots, not a
lossless stream of agent and tool output.

The viewer displays user and assistant messages, command invocations, full
persisted command output, file changes, extension results, and reasoning
summaries. Codex does not expose private chain-of-thought, and output already
truncated before it reaches the transcript cannot be recovered.

Valid JSON and JSONL command output is pretty-printed. JSON string values longer
than 500 characters and collections longer than 100 items are shortened for
display; the source transcript remains unchanged. Override those defaults with
`AGENT_STREAM_MAX_JSON_STRING_LENGTH` and
`AGENT_STREAM_MAX_JSON_COLLECTION_ITEMS`.

Section headers and message bodies use distinct colors. Pretty-printed JSON
uses cyan keys, green strings, yellow numbers, magenta booleans, and dim nulls.
Set `NO_COLOR=1` to disable all added coloring.

Each event shows elapsed time since the previous rendered event, such as `7s`,
`6m7s`, or `1h5m`, using a consistent white label. Commands use shell-style
`$ command` rendering, shortened home paths, duration and outcome badges, and
full-width separators. File changes are rendered as colored unified diffs.
Reads of the stream pane itself are suppressed to prevent recursive output while
leaving the original result in the transcript.

The default pane is an interactive alternate-screen TUI. Use the ordinary
wheel to scroll freely through the conversation and Shift+wheel to jump to the
previous or next message. Clicking a visible message selects it, after which
`j`/`k` move relative to that message. `g` moves to the first message, and `G`
returns to the newest message and resumes live follow.

The `stream-plain` pane entrypoint retains the original append-only viewer when
native terminal scrollback is preferred. The TUI keeps a bounded history in
memory while the complete source remains in the transcript.

Command lines use lightweight shell syntax highlighting for executables,
subcommands, flags, paths, quoted strings, assignments, variables, and shell
operators. This is intentionally a display tokenizer rather than a shell
parser, so it never changes command execution or transcript contents. Flags,
paths, quoted strings, assignments, and variables use italics when the terminal
font supports them.

Unknown and tool-specific item types are converted from PascalCase into spaced
uppercase labels (`McpToolCall` becomes `MCP TOOL CALL`). Every message header
uses its former text color as the background across the full row, with a
contrast-safe text color.

## Installation

```sh
herdr plugin install tingwai/skills/herdr-plugins/agent-stream
```

For local development from the `my-skills` repository root:

```sh
herdr plugin link ./herdr-plugins/agent-stream --enabled
```

Herdr's native `pane.agent_detected` event opens the split beside the
originating pane without moving focus. No Codex configuration is modified. One
viewer is kept per source pane, including across duplicate events. The plugin
startup hook also discovers Codex sessions that were already running when
Herdr loaded the plugin.
