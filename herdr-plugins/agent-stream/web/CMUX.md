# Cmux browser stream

This is lightweight glue around the existing read-only browser session tape.
It is the automatic Cmux viewer; the terminal TUI remains available as the
manual fallback and the Herdr viewer is unchanged.

From the Codex terminal surface in Cmux, run one command:

```sh
node /Users/tingwai/my-skills/skills/open-codex-stream/scripts/open_web_stream_cmux.mjs
```

The launcher starts the local SSE viewer on the first free port from 4319
through 4350 and immediately creates or restores an unfocused browser pane to
the right. It does not wait for Cmux to register a session. Until the exact
calling surface has an authoritative Codex transcript, the pane shows the
intentional `Nothing to display yet.` empty state and attaches in place later.
The page follows new
events until the reader scrolls upward, clicks an event, or pauses follow. The
`Jump to live` button (or `G`) returns to the newest event.

The IDE Activity Rail layout keeps the readable stream beside a narrow sampled
whole-session minimap. Clicking or dragging the minimap selects the matching
transcript event; selecting the newest event resumes live follow. Each mark's
horizontal width represents its event body's text length using logarithmic
normalization, so extreme output does not flatten ordinary messages. Long
sessions use the median text length within each bounded aggregate bin rather
than implying an exact per-event value.

If Codex `/resume` changes the active conversation in the same source surface,
the server detects Cmux's new active session, clears the old browser tape, loads
the resumed transcript's retained history, and follows it in the existing pane.

For server-only testing outside Cmux:

```sh
node skills/open-codex-stream/scripts/open_web_stream_cmux.mjs \
  --transcript /absolute/path/to/rollout.jsonl --no-open
```

Automatic launches are internal zsh function logic and never paste a command
into the interactive terminal. Diagnostics are written under
`~/.cmuxterm/agent-stream-web/`. The browser server exits after its pane has
been disconnected for 30 seconds; server-only testing reports a PID that must
be stopped manually.
