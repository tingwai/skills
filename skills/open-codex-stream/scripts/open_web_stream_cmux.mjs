#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const argumentsList = process.argv.slice(2);

function optionValue(name) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] ?? "" : "";
}

const noOpen = argumentsList.includes("--no-open");
const automatic = argumentsList.includes("--auto");
const explicitTranscript = optionValue("--transcript");
const explicitPort = Number.parseInt(optionValue("--port"), 10);
const sourceSurfaceId = process.env.CMUX_SURFACE_ID ?? "";
const workspaceId = process.env.CMUX_WORKSPACE_ID ?? "";
const cmux = resolveCmuxBinary();
const webServer = path.resolve(import.meta.dirname, "../../../herdr-plugins/agent-stream/web/server.mjs");
const stateDirectory = process.env.AGENT_STREAM_WEB_STATE_DIRECTORY
  ?? path.join(os.homedir(), ".cmuxterm", "agent-stream-web");
const safeSurfaceId = sourceSurfaceId.replace(/[^a-zA-Z0-9._-]/gu, "_") || "server-only";
const statePath = path.join(stateDirectory, `${safeSurfaceId}.json`);
const lockPath = `${statePath}.lock`;

function fail(message) {
  throw new Error(message);
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
    maxBuffer: 8 * 1024 * 1024,
    timeout: 8_000,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail(result.error?.message || result.stderr.trim() || `cmux ${args[0]} failed`);
  }
  return result;
}

function transcriptCandidates() {
  const result = invoke([
    "sessions", "--agent", "codex", "--surface", sourceSurfaceId, "--all", "--json",
  ], true);
  if (result.error || result.status !== 0) return [];
  let sessions;
  try {
    sessions = JSON.parse(result.stdout)?.sessions ?? [];
  } catch {
    return [];
  }
  return sessions
    .filter((session) => session.surface_id === sourceSurfaceId || session.surfaceId === sourceSurfaceId)
    .filter((session) => session.codex_transcript_path || session.transcript_path)
    .filter((session) => fs.existsSync(session.codex_transcript_path ?? session.transcript_path))
    .sort((left, right) =>
      Number(right.updated_at_unix ?? 0) - Number(left.updated_at_unix ?? 0));
}

function resolveSession() {
  if (explicitTranscript) {
    return { transcriptPath: path.resolve(explicitTranscript), sessionId: null };
  }
  if (!sourceSurfaceId) fail("Run this viewer from the Codex terminal in Cmux, or pass --transcript PATH.");
  if (automatic) return null;
  const candidates = transcriptCandidates();
  const declaredActiveId = candidates.find((session) => session.active_surface_session_id)
    ?.active_surface_session_id;
  const selected = candidates.find((session) => session.active_for_surface)
    ?? candidates.find((session) =>
      (session.session_id ?? session.sessionId) === declaredActiveId);
  return selected ? {
    transcriptPath: selected.codex_transcript_path ?? selected.transcript_path,
    sessionId: selected.session_id ?? selected.sessionId ?? null,
  } : null;
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function choosePort() {
  if (Number.isInteger(explicitPort)) {
    if (explicitPort < 1 || explicitPort > 65_535) fail("--port must be between 1 and 65535.");
    if (!await portIsAvailable(explicitPort)) fail(`Port ${explicitPort} is already in use.`);
    return explicitPort;
  }
  for (let port = 4319; port <= 4350; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  fail("No free viewer port was found between 4319 and 4350.");
}

function waitForHealth(url) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      attempts += 1;
      const request = http.get(`${url}health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else if (attempts < 40) setTimeout(poll, 50);
        else reject(new Error("The browser stream server did not become ready."));
      });
      request.on("error", () => {
        if (attempts < 40) setTimeout(poll, 50);
        else reject(new Error("The browser stream server did not become ready."));
      });
    };
    poll();
  });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "EPERM";
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 && result.stdout.includes("agent-stream/web/server.mjs");
}

function stopServer(pid) {
  if (!processIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* The server already exited. */ }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function browserSurfaceExists(surfaceId) {
  if (!surfaceId) return false;
  const result = invoke(["browser", "--surface", surfaceId, "get-url"], true);
  return !result.error && result.status === 0;
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

async function startServer(session) {
  const port = await choosePort();
  const url = `http://127.0.0.1:${port}/`;
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const logPath = path.join(stateDirectory, `server-${safeSurfaceId}-${port}.log`);
  const logDescriptor = fs.openSync(logPath, "a", 0o600);
  const serverArguments = [webServer, "--port", String(port)];
  if (session?.transcriptPath) serverArguments.push("--transcript", session.transcriptPath);
  if (!noOpen) serverArguments.push("--exit-idle", "30");
  if (sourceSurfaceId) {
    serverArguments.push("--cmux-surface", sourceSurfaceId, "--cmux-bin", cmux);
    if (session?.sessionId) serverArguments.push("--session-id", session.sessionId);
  }
  const child = spawn(process.execPath, serverArguments, {
    detached: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logDescriptor);
  try {
    await waitForHealth(url);
  } catch (error) {
    stopServer(child.pid);
    fail(`${error.message} See ${logPath}`);
  }
  return { url, serverPid: child.pid, logPath };
}

function writeState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function acquireLock() {
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") fail(`Could not acquire the browser viewer lock: ${error.message}`);
      let stale = false;
      try { stale = Date.now() - fs.statSync(lockPath).mtimeMs > 20_000; } catch { stale = true; }
      if (!stale) return false;
      try { fs.rmdirSync(lockPath); } catch { /* Another launcher handled it. */ }
    }
  }
  return false;
}

function releaseLock() {
  try { fs.rmdirSync(lockPath); } catch { /* Preserve the original result. */ }
}

function writeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (["--transcript", "--port"].includes(argument)) index += 1;
    else if (!["--no-open", "--auto"].includes(argument)) fail(`Unknown option: ${argument}`);
  }
  if (!noOpen && (!sourceSurfaceId || !workspaceId)) {
    fail("Run this viewer from a Cmux terminal (CMUX_SURFACE_ID and CMUX_WORKSPACE_ID are required), or pass --no-open.");
  }

  const session = resolveSession();
  if (session?.transcriptPath
      && (!fs.existsSync(session.transcriptPath) || path.extname(session.transcriptPath) !== ".jsonl")) {
    fail(`The Codex transcript is not a readable .jsonl file: ${session.transcriptPath}`);
  }
  if (noOpen) {
    const server = await startServer(session);
    writeResult({
      status: "serving",
      runtime: "cmux-browser",
      transcriptPath: session?.transcriptPath ?? null,
      sessionId: session?.sessionId ?? null,
      ...server,
    });
    return;
  }

  if (!acquireLock()) {
    writeResult({ status: "open_pending", runtime: "cmux-browser", sourceSurfaceId });
    return;
  }
  try {
    const previous = readState();
    const previousSurfaceExists = browserSurfaceExists(previous?.viewerSurfaceId);
    if (processIsAlive(previous?.serverPid)
        && previousSurfaceExists
        && (!explicitTranscript || previous.transcriptPath === session?.transcriptPath)) {
      writeResult({ ...previous, status: "already_open" });
      return;
    }

    const server = await startServer(session);
    let viewerSurfaceId = previousSurfaceExists ? previous.viewerSurfaceId : null;
    if (viewerSurfaceId) {
      const navigateResult = invoke([
        "browser", "--surface", viewerSurfaceId, "navigate", server.url,
      ], true);
      if (navigateResult.error || navigateResult.status !== 0) viewerSurfaceId = null;
    }

    if (!viewerSurfaceId) {
      const openResult = invoke([
        "--json", "--id-format", "uuids", "new-pane",
        "--type", "browser", "--direction", "right",
        "--workspace", workspaceId, "--url", server.url, "--focus", "false",
      ], true);
      if (openResult.error || openResult.status !== 0) {
        stopServer(server.serverPid);
        const detail = openResult.error?.message || openResult.stderr.trim() || "unknown error";
        fail(`Cmux could not create the browser pane: ${detail}`);
      }
      let payload;
      try { payload = JSON.parse(openResult.stdout); } catch { payload = null; }
      viewerSurfaceId = collectValue(payload, "surface_id")
        ?? collectValue(payload, "surfaceId")
        ?? collectValue(payload, "id");
      if (!viewerSurfaceId || viewerSurfaceId === sourceSurfaceId) {
        stopServer(server.serverPid);
        fail(`Cmux created a browser pane but did not return its surface ID: ${openResult.stdout.trim()}`);
      }
    }

    const state = {
      status: previousSurfaceExists ? "restored" : "opened",
      runtime: "cmux-browser",
      sourceSurfaceId,
      viewerSurfaceId,
      transcriptPath: session?.transcriptPath ?? null,
      sessionId: session?.sessionId ?? null,
      ...server,
      openedAt: Date.now(),
    };
    writeState(state);
    if (previous?.serverPid !== server.serverPid) stopServer(previous?.serverPid);
    writeResult(state);
  } finally {
    releaseLock();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
