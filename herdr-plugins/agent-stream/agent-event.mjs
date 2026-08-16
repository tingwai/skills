import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function findTranscript(directory, sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = findTranscript(entryPath, sessionId);
      if (match) return match;
    } else if (entry.name.endsWith(`${sessionId}.jsonl`)) {
      return entryPath;
    }
  }
  return null;
}

function viewerAlreadyOpening(paneId, sessionId) {
  const safePaneId = paneId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const statePath = path.join(os.tmpdir(), "herdr-agent-stream", `${safePaneId}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.sessionId !== sessionId) return false;
    if (!state.pid) return Date.now() - state.openedAt < 15_000;
    try {
      process.kill(state.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  } catch {
    return false;
  }
}

const paneId = process.env.HERDR_PANE_ID;
if (!paneId) process.exit(0);

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const paneResult = spawnSync(herdr, ["pane", "get", paneId], {
  encoding: "utf8",
  env: process.env,
  timeout: 3_000,
});

if (paneResult.status !== 0) process.exit(0);

let pane;
try {
  pane = JSON.parse(paneResult.stdout)?.result?.pane;
} catch {
  process.exit(0);
}

const agentSession = pane?.agent_session;
if (agentSession?.agent !== "codex" || agentSession.kind !== "id") process.exit(0);
if (viewerAlreadyOpening(paneId, agentSession.value)) process.exit(0);

const transcriptPath = findTranscript(
  path.join(os.homedir(), ".codex", "sessions"),
  agentSession.value,
);
if (!transcriptPath) process.exit(0);

const hookResult = spawnSync(
  process.execPath,
  [path.join(process.env.HERDR_PLUGIN_ROOT ?? import.meta.dirname, "session-hook.mjs")],
  {
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      cwd: pane.cwd,
      session_id: agentSession.value,
      transcript_path: transcriptPath,
    }),
    timeout: 8_000,
  },
);

if (hookResult.status !== 0 && hookResult.stderr) {
  process.stderr.write(hookResult.stderr);
}
