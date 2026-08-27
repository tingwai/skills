#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const options = new Set(process.argv.slice(2));

const sourceSurfaceId = process.env.CMUX_SURFACE_ID ?? "";
const workspaceId = process.env.CMUX_WORKSPACE_ID ?? "";
const cmux = resolveCmuxBinary();
const stateDirectory = process.env.AGENT_STREAM_STATE_DIRECTORY
  ?? path.join(os.homedir(), ".cmuxterm", "agent-stream");
const safeSurfaceId = sourceSurfaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
const statePath = path.join(stateDirectory, `${safeSurfaceId}.json`);
const lockPath = `${statePath}.lock`;
const viewerScript = path.join(import.meta.dirname, "cmux_stream.mjs");
const notBefore = options.has("--auto") ? Date.now() / 1_000 - 1 : 0;

function fail(message, details) {
  const suffix = details ? `: ${details}` : "";
  throw new Error(`${message}${suffix}`);
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function resolveCmuxBinary() {
  const candidates = [
    process.env.CMUX_BIN_PATH,
    process.env.CMUX_BUNDLED_CLI_PATH,
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    "cmux",
  ].filter(Boolean);
  return candidates.find((candidate) => {
    if (candidate === "cmux") return true;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? "cmux";
}

function invoke(args, allowFailure = false) {
  const result = spawnSync(cmux, args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 8_000,
  });
  if (result.error && !allowFailure) fail("Could not run cmux", result.error.message);
  if (result.status !== 0 && !allowFailure) {
    fail(`Cmux command failed: cmux ${args.join(" ")}`, result.stderr.trim());
  }
  return result;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function viewerIsAlive(state) {
  const pid = state?.pid;
  if (state?.runtime !== "cmux" || state?.sourceSurfaceId !== sourceSurfaceId) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0
    && /(?:tui|cmux_stream)\.mjs(?:\s|$)/u.test(result.stdout);
}

function collectValue(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = collectValue(item, key);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (typeof value[key] === "string") return value[key];
  for (const nested of Object.values(value)) {
    const match = collectValue(nested, key);
    if (match) return match;
  }
  return null;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function surfaceExists(surfaceId) {
  if (!surfaceId) return false;
  return invoke(["read-screen", "--surface", surfaceId, "--lines", "1"], true).status === 0;
}

function waitForViewer() {
  const sleepSignal = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (viewerIsAlive(readState())) return true;
    Atomics.wait(sleepSignal, 0, 0, 100);
  }
  return false;
}

function viewerCommand(viewerSurfaceId) {
  return [
    "env",
    `AGENT_STREAM_STATE_PATH=${statePath}`,
    "AGENT_STREAM_RUNTIME=cmux",
    `CODEX_SOURCE_PANE_ID=${sourceSurfaceId}`,
    `CMUX_AGENT_STREAM_VIEWER_SURFACE_ID=${viewerSurfaceId}`,
    process.execPath,
    viewerScript,
    "--source-surface",
    sourceSurfaceId,
    "--viewer-surface",
    viewerSurfaceId,
    "--not-before",
    String(notBefore),
  ].map(shellQuote).join(" ");
}

function startViewer(viewerSurfaceId) {
  fs.writeFileSync(statePath, `${JSON.stringify({
    runtime: "cmux",
    sourceSurfaceId,
    viewerSurfaceId,
    openedAt: Date.now(),
  })}\n`, { mode: 0o600 });
  const result = invoke([
    "send", "--surface", viewerSurfaceId, "--", `${viewerCommand(viewerSurfaceId)}\\n`,
  ], true);
  if (result.status !== 0) {
    fail("Could not start the Codex stream viewer", result.stderr.trim());
  }
  invoke([
    "rename-tab", "--surface", viewerSurfaceId, "--focus", "false", "Codex stream",
  ], true);
  if (!waitForViewer()) {
    fail(`The Codex stream viewer did not start on Cmux surface ${viewerSurfaceId}`);
  }
}

function main() {
  for (const option of options) {
    if (option !== "--auto") fail(`Unknown option: ${option}`);
  }
  if (process.env.HERDR_ENV === "1") fail("The Cmux launcher cannot run inside Herdr");
  if (!sourceSurfaceId || !workspaceId) {
    fail("This launcher must run inside a Cmux terminal (CMUX_SURFACE_ID and CMUX_WORKSPACE_ID are required)");
  }

  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  let lockAcquired = false;
  for (let attempt = 0; attempt < 2 && !lockAcquired; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      lockAcquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("Could not acquire the viewer lock", error.message);
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > 15_000;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // Another launcher may have replaced or removed the stale lock.
        }
      } else {
        break;
      }
    }
  }
  if (!lockAcquired) {
    const pendingState = readState();
    writeResult({
      status: "open_pending",
      runtime: "cmux",
      source_surface_id: sourceSurfaceId,
      viewer_surface_id: pendingState?.viewerSurfaceId ?? null,
    });
    return;
  }

  try {
    const existingState = readState();
    if (viewerIsAlive(existingState)) {
      writeResult({
        status: "already_open",
        runtime: "cmux",
        source_surface_id: sourceSurfaceId,
        viewer_surface_id: existingState.viewerSurfaceId ?? null,
      });
      return;
    }

    if (surfaceExists(existingState?.viewerSurfaceId)) {
      startViewer(existingState.viewerSurfaceId);
      writeResult({
        status: "restored",
        runtime: "cmux",
        source_surface_id: sourceSurfaceId,
        viewer_surface_id: existingState.viewerSurfaceId,
      });
      return;
    }

    const splitResult = invoke([
      "--json", "--id-format", "uuids", "new-split", "right",
      "--workspace", workspaceId,
      "--surface", sourceSurfaceId,
      "--focus", "false",
    ]);
    let payload;
    try {
      payload = JSON.parse(splitResult.stdout);
    } catch (error) {
      fail("Cmux returned invalid JSON while creating the viewer split", error.message);
    }
    const viewerSurfaceId = collectValue(payload, "surface_id")
      ?? collectValue(payload, "surfaceId")
      ?? collectValue(payload, "id");
    if (!viewerSurfaceId || viewerSurfaceId === sourceSurfaceId) {
      fail("Cmux did not return the new viewer surface ID");
    }

    try {
      startViewer(viewerSurfaceId);
    } catch (error) {
      invoke(["close-surface", "--surface", viewerSurfaceId], true);
      throw error;
    }
    writeResult({
      status: "opened",
      runtime: "cmux",
      source_surface_id: sourceSurfaceId,
      viewer_surface_id: viewerSurfaceId,
    });
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // A failed launch should not hide the original error.
    }
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
