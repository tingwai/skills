#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { enterEmptyState } from "../../../herdr-plugins/agent-stream/viewer-rendering.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

const sourceSurfaceId = optionValue("--source-surface");
const viewerSurfaceId = optionValue("--viewer-surface");
const notBefore = Number.parseFloat(optionValue("--not-before")) || 0;
const waitAttempts = Number.parseInt(process.env.AGENT_STREAM_SESSION_WAIT_ATTEMPTS ?? "", 10);
const sessionWaitAttempts = Number.isInteger(waitAttempts) && waitAttempts > 0
  ? waitAttempts
  : Number.POSITIVE_INFINITY;
const statePath = process.env.AGENT_STREAM_STATE_PATH ?? "";
const cmux = process.env.CMUX_BIN_PATH
  ?? process.env.CMUX_BUNDLED_CLI_PATH
  ?? "/Applications/cmux.app/Contents/Resources/bin/cmux";

function persistState(extra = {}) {
  if (!statePath) return;
  try {
    fs.writeFileSync(statePath, `${JSON.stringify({
      runtime: "cmux",
      sourceSurfaceId,
      viewerSurfaceId,
      pid: process.pid,
      openedAt: Date.now(),
      ...extra,
    })}\n`, { mode: 0o600 });
  } catch {
    // The viewer still works without deduplication state.
  }
}

function sessionsForSurface() {
  const result = spawnSync(cmux, [
    "sessions", "--agent", "codex", "--surface", sourceSurfaceId, "--all", "--json",
  ], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8_000,
  });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout)?.sessions ?? [];
  } catch {
    return [];
  }
}

function usableTranscript(session) {
  const transcriptPath = session.codex_transcript_path ?? session.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  if (notBefore && Number(session.updated_at_unix ?? 0) < notBefore) return null;
  return { session, transcriptPath };
}

async function waitForSession() {
  for (let attempt = 0; attempt < sessionWaitAttempts; attempt += 1) {
    const candidates = sessionsForSurface()
      .map(usableTranscript)
      .filter(Boolean)
      .sort((left, right) =>
        Number(right.session.updated_at_unix ?? 0) - Number(left.session.updated_at_unix ?? 0));
    const selected = candidates.find(({ session }) => session.active_for_surface) ?? candidates[0];
    if (selected) return selected;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function showEmptyState() {
  process.stdout.write(enterEmptyState(process.stdout.columns, process.stdout.rows));
}

function restoreScreen() {
  process.stdout.write("\u001b[?25h\u001b[?1049l");
}

if (!sourceSurfaceId || !viewerSurfaceId) {
  process.stderr.write("Missing Cmux source or viewer surface identity.\n");
  process.exit(1);
}

showEmptyState();
persistState();
const resolved = await waitForSession();
if (!resolved) {
  persistState({ pid: null, closedAt: Date.now(), error: "session_timeout" });
  restoreScreen();
  process.stderr.write("Timed out waiting for Cmux to associate this surface with a Codex session.\n");
  process.exit(1);
}

const tuiPath = process.env.AGENT_STREAM_TUI_PATH
  ?? path.resolve(import.meta.dirname, "../../../herdr-plugins/agent-stream/tui.mjs");
const result = spawnSync(process.execPath, [tuiPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENT_STREAM_RUNTIME: "cmux",
    CODEX_TRANSCRIPT_PATH: resolved.transcriptPath,
    CODEX_SESSION_ID: resolved.session.session_id,
    CODEX_SOURCE_PANE_ID: sourceSurfaceId,
    CMUX_AGENT_STREAM_VIEWER_SURFACE_ID: viewerSurfaceId,
  },
});
if (result.status === 73) {
  // The TUI requested closure of this dedicated surface. Keep its alternate
  // screen visible until Cmux removes the surface so no shell prompt flashes.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  restoreScreen();
  process.exit(1);
}
restoreScreen();
process.exit(result.status ?? 1);
