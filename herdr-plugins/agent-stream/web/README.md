# Browser session tape

This is a richer browser view of the same append-only Codex JSONL transcript
used by the Herdr terminal pane. A dependency-free local Node server retains a
bounded event history and sends new records to the page with Server-Sent
Events. It polls only newly appended bytes every 150 ms; it does not scrape the
terminal or rewrite the transcript.

The UI includes:

- a chronological time rail showing elapsed time since the previous displayed
  event (`7s`, `6m7s`, or `1h5m`; the first event is `0s`)
- explicit user-turn boundaries and semantic event colors
- full-width category-color headers with readable labels for tool-specific
  event types such as `MCP TOOL CALL`
- command status, exit-code, and duration badges
- shortened home paths and shell-style command rendering
- searchable, filterable events with follow/pause controls
- click selection followed by `j`/`k` navigation between visible events
- `Shift`+wheel navigation with a Mac trackpad-friendly time throttle, while
  ordinary wheel scrolling remains native
- `g` to jump to the first visible event and `G` to resume live follow at the
  newest event
- semantic shell highlighting for commands, subcommands, flags, paths,
  strings, variables, operators, and operands
- colored file diffs and semantic JSON values
- collapsed JSON strings over 500 characters and collections over 100 items
- recursive `herdr pane read` output suppression

Long JSON values can be expanded in the browser. Display limits never modify
the full source values in the transcript.

## Launch

Pass the exact transcript you want to watch:

```sh
node herdr-plugins/agent-stream/web/server.mjs \
  --transcript /Users/tingwai/.codex/sessions/YYYY/MM/DD/rollout-SESSION_ID.jsonl
```

Then open <http://127.0.0.1:4319/>. The listener binds only to `127.0.0.1`,
serves only its three bundled assets, applies a restrictive Content Security
Policy, and never exposes the transcript as a downloadable file.

Options:

```text
--port PORT       Local port (default: 4319)
--history COUNT   Prior renderable events sent on connection (default: 250)
```

Stop the server with `Ctrl-C`.
