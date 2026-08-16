import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

const hookInput = JSON.parse(await readStdin());
const sourcePaneId = process.env.HERDR_PANE_ID;
const transcriptPath = hookInput.transcript_path;
const sessionId = hookInput.session_id ?? "";

if (process.env.HERDR_ENV !== "1" || !sourcePaneId || !transcriptPath) process.exit(0);

const stateDirectory = path.join(os.tmpdir(), "herdr-agent-stream");
const safePaneId = sourcePaneId.replace(/[^a-zA-Z0-9._-]/g, "_");
const statePath = path.join(stateDirectory, `${safePaneId}.json`);
fs.mkdirSync(stateDirectory, { recursive: true });

const previousState = readState(statePath);
const sameTranscript = previousState?.transcriptPath === transcriptPath;
const viewerIsAlive = processIsAlive(previousState?.pid);
const openIsPending = !previousState?.pid
  && Date.now() - (previousState?.openedAt ?? 0) < 15_000;

if (sameTranscript && (viewerIsAlive || openIsPending)) process.exit(0);

if (viewerIsAlive) {
  try {
    process.kill(previousState.pid, "SIGTERM");
  } catch {
    // The previous viewer may have exited between the liveness check and signal.
  }
}

fs.writeFileSync(
  statePath,
  `${JSON.stringify({ transcriptPath, sessionId, openedAt: Date.now() })}\n`,
);

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const result = spawnSync(herdr, [
  "plugin", "pane", "open",
  "--plugin", "tingwai.agent-stream",
  "--entrypoint", "stream",
  "--placement", "split",
  "--target-pane", sourcePaneId,
  "--direction", "right",
  "--env", `CODEX_TRANSCRIPT_PATH=${transcriptPath}`,
  "--env", `CODEX_SOURCE_PANE_ID=${sourcePaneId}`,
  "--env", `CODEX_SESSION_ID=${sessionId}`,
  "--env", `AGENT_STREAM_STATE_PATH=${statePath}`,
  "--no-focus",
], { encoding: "utf8", env: process.env, timeout: 7_000 });

if (result.status !== 0) {
  try {
    fs.unlinkSync(statePath);
  } catch {
    // There may be no state file left to remove.
  }
  const detail = result.stderr?.trim() || result.error?.message || "unknown error";
  process.stderr.write(`Could not open the Codex stream pane: ${detail}\n`);
  process.exit(result.status ?? 1);
}
