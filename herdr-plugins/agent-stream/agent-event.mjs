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
const isCodex = pane?.agent === "codex" || agentSession?.agent === "codex";
if (!isCodex) process.exit(0);

const sessionId = agentSession?.kind === "id" ? agentSession.value : "";
const transcriptPath = sessionId
  ? findTranscript(path.join(os.homedir(), ".codex", "sessions"), sessionId)
  : null;

const hookResult = spawnSync(
  process.execPath,
  [path.join(process.env.HERDR_PLUGIN_ROOT ?? import.meta.dirname, "session-hook.mjs")],
  {
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      cwd: pane.cwd,
      session_id: sessionId,
      transcript_path: transcriptPath,
    }),
    timeout: 8_000,
  },
);

if (hookResult.status !== 0 && hookResult.stderr) {
  process.stderr.write(hookResult.stderr);
}
