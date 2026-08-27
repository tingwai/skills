import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(moduleDirectory, "public");

function usage() {
  return `Usage: node web/server.mjs [--transcript PATH] [--port PORT] [--history COUNT] [--exit-idle SECONDS] [--cmux-surface ID] [--cmux-events PATH]\n\n` +
    `Serves the transcript viewer on 127.0.0.1 only.\n`;
}

function parseArguments(argumentsList) {
  const values = { port: 4319, history: 250 };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--transcript") values.transcript = argumentsList[index += 1];
    else if (argument === "--port") values.port = Number.parseInt(argumentsList[index += 1], 10);
    else if (argument === "--history") values.history = Number.parseInt(argumentsList[index += 1], 10);
    else if (argument === "--exit-idle") values.exitIdle = Number.parseInt(argumentsList[index += 1], 10);
    else if (argument === "--cmux-surface") values.cmuxSurface = argumentsList[index += 1];
    else if (argument === "--cmux-bin") values.cmuxBin = argumentsList[index += 1];
    else if (argument === "--cmux-events") values.cmuxEvents = argumentsList[index += 1];
    else if (argument === "--session-id") values.sessionId = argumentsList[index += 1];
    else if (argument === "--session-poll-ms") {
      values.sessionPollMs = Number.parseInt(argumentsList[index += 1], 10);
    }
    else if (argument === "--help" || argument === "-h") values.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}`);
  process.exit(2);
}

if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}
if (!options.transcript && !options.cmuxSurface) {
  process.stderr.write(`--transcript or --cmux-surface is required.\n\n${usage()}`);
  process.exit(2);
}
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
  process.stderr.write("--port must be an integer from 1 through 65535.\n");
  process.exit(2);
}
if (!Number.isInteger(options.history) || options.history < 0 || options.history > 10_000) {
  process.stderr.write("--history must be an integer from 0 through 10000.\n");
  process.exit(2);
}
if (options.exitIdle !== undefined
    && (!Number.isInteger(options.exitIdle) || options.exitIdle < 1 || options.exitIdle > 3_600)) {
  process.stderr.write("--exit-idle must be an integer from 1 through 3600.\n");
  process.exit(2);
}
if (options.cmuxSurface && !options.cmuxBin) options.cmuxBin = "cmux";
if (options.cmuxSurface && !options.cmuxEvents) {
  options.cmuxEvents = path.join(os.homedir(), ".cmuxterm", "events.jsonl");
}
if (options.sessionPollMs !== undefined
    && (!Number.isInteger(options.sessionPollMs) || options.sessionPollMs < 20 || options.sessionPollMs > 10_000)) {
  process.stderr.write("--session-poll-ms must be an integer from 20 through 10000.\n");
  process.exit(2);
}

let transcriptPath = options.transcript ? path.resolve(options.transcript) : null;
let transcriptStat = null;
if (transcriptPath) {
  try {
    transcriptStat = fs.statSync(transcriptPath);
  } catch (error) {
    process.stderr.write(`Cannot read transcript: ${error.message}\n`);
    process.exit(1);
  }
  if (!transcriptStat.isFile() || path.extname(transcriptPath) !== ".jsonl") {
    process.stderr.write("The transcript must be a readable .jsonl file.\n");
    process.exit(1);
  }
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const staticFiles = new Map([
  ["/", [path.join(publicDirectory, "index.html"), "text/html; charset=utf-8"]],
  ["/app.js", [path.join(publicDirectory, "app.js"), "text/javascript; charset=utf-8"]],
  ["/markdown-renderer.js", [path.join(publicDirectory, "markdown-renderer.js"), "text/javascript; charset=utf-8"]],
  ["/selection-state.js", [path.join(publicDirectory, "selection-state.js"), "text/javascript; charset=utf-8"]],
  ["/minimap.js", [path.join(publicDirectory, "minimap.js"), "text/javascript; charset=utf-8"]],
  ["/styles.css", [path.join(publicDirectory, "styles.css"), "text/css; charset=utf-8"]],
  ["/ide-rail.css", [path.join(publicDirectory, "ide-rail.css"), "text/css; charset=utf-8"]],
  ["/markdown.css", [path.join(publicDirectory, "markdown.css"), "text/css; charset=utf-8"]],
]);
const clients = new Set();
const history = [];
const serverStartedAt = Date.now();
const initialSessionNotBefore = serverStartedAt - 2_000;
let position = 0;
let partialLine = "";
let loading = true;
let lastClientDisconnectedAt = null;
let currentSessionId = options.sessionId ?? null;
let cmuxEventPosition = 0;
let cmuxEventPartialLine = "";
let pendingCmuxHookSessionId = null;
try { cmuxEventPosition = fs.statSync(options.cmuxEvents).size; } catch { /* The log is optional. */ }

function browserRecord(record) {
  if (record?.type !== "event_msg") return false;
  if (!["item_completed", "user_message", "agent_message"].includes(record.payload?.type)) return null;
  const item = record.payload?.item;
  if (item?.type !== "Reasoning") return record;
  return {
    type: record.type,
    timestamp: record.timestamp,
    payload: {
      type: record.payload.type,
      item: { type: "Reasoning", summary_text: item.summary_text },
    },
  };
}

function sendEvent(response, event, value) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function publishRecord(record, retain = true) {
  const safeRecord = browserRecord(record);
  if (!safeRecord) return;
  if (retain && options.history > 0) {
    history.push(safeRecord);
    if (history.length > options.history) history.shift();
  }
  for (const response of clients) sendEvent(response, "record", safeRecord);
}

function consumeText(text, retain = true) {
  partialLine += text;
  const lines = partialLine.split("\n");
  partialLine = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    try {
      publishRecord(JSON.parse(line), retain);
    } catch (error) {
      for (const response of clients) {
        sendEvent(response, "warning", { message: `Skipped invalid JSONL record: ${error.message}` });
      }
    }
  }
}

function transcriptSnapshot(nextTranscriptPath) {
  const descriptor = fs.openSync(nextTranscriptPath, "r");
  const records = [];
  let nextPosition = 0;
  let nextPartialLine = "";
  try {
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (nextPosition < size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - nextPosition),
        nextPosition,
      );
      if (bytesRead === 0) break;
      nextPosition += bytesRead;
      nextPartialLine += buffer.toString("utf8", 0, bytesRead);
      const lines = nextPartialLine.split("\n");
      nextPartialLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const safeRecord = browserRecord(JSON.parse(line));
          if (!safeRecord || options.history === 0) continue;
          records.push(safeRecord);
          if (records.length > options.history) records.shift();
        } catch {
          // Match the live reader: malformed lines are skipped without blocking the session switch.
        }
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { nextPosition, nextPartialLine, records };
}

function switchTranscript(nextTranscriptPath, nextSessionId) {
  const resolvedPath = path.resolve(nextTranscriptPath);
  if (transcriptPath && resolvedPath === transcriptPath) {
    currentSessionId = nextSessionId ?? currentSessionId;
    return;
  }
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile() || path.extname(resolvedPath) !== ".jsonl") return;
  const snapshot = transcriptSnapshot(resolvedPath);

  transcriptPath = resolvedPath;
  currentSessionId = nextSessionId ?? null;
  position = snapshot.nextPosition;
  partialLine = snapshot.nextPartialLine;
  loading = false;
  history.splice(0, history.length, ...snapshot.records);
  for (const response of clients) {
    sendEvent(response, "session", {
      sessionId: currentSessionId,
      transcript: path.basename(transcriptPath),
      reason: "active_session_changed",
    });
    for (const record of history) sendEvent(response, "record", record);
    sendEvent(response, "ready", {
      loading: false,
      sessionId: currentSessionId,
      transcript: path.basename(transcriptPath),
      retainedEvents: history.length,
    });
  }
  process.stdout.write(`Switched to ${transcriptPath}\n`);
}

function cmuxSessions(argumentsList) {
  const result = spawnSync(options.cmuxBin, ["sessions", "--agent", "codex", ...argumentsList, "--all", "--json"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 4_000,
  });
  if (result.error || result.status !== 0) return [];
  try { return JSON.parse(result.stdout)?.sessions ?? []; } catch { return []; }
}

function sessionDetails(session, fallbackSessionId = null) {
  const transcript = session?.codex_transcript_path ?? session?.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return null;
  return {
    sessionId: session.session_id ?? session.sessionId ?? fallbackSessionId,
    transcriptPath: transcript,
  };
}

function normalizedCodexSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("codex-")
    ? sessionId.slice("codex-".length)
    : sessionId;
}

function activeCmuxSession() {
  if (!options.cmuxSurface) return null;
  const sessions = cmuxSessions(["--surface", options.cmuxSurface]);
  const exactSessions = sessions.filter((session) =>
    (session.surface_id === options.cmuxSurface || session.surfaceId === options.cmuxSurface)
    && (session.codex_transcript_path || session.transcript_path));
  const declaredActiveId = exactSessions.find((session) => session.active_surface_session_id)
    ?.active_surface_session_id;
  const active = exactSessions.find((session) => session.active_for_surface)
    ?? exactSessions.find((session) => session.session_id === declaredActiveId);
  if (active) return sessionDetails(active, declaredActiveId);
  if (transcriptPath) return null;
  const newlyRegistered = exactSessions
    .filter((session) => {
      const startedAt = Date.parse(session.started_at ?? session.startedAt ?? "");
      return Number.isFinite(startedAt) && startedAt >= initialSessionNotBefore;
    })
    .sort((left, right) =>
      Number(right.updated_at_unix ?? 0) - Number(left.updated_at_unix ?? 0))[0];
  return newlyRegistered ? sessionDetails(newlyRegistered) : null;
}

function cmuxSessionForHook(sessionId) {
  const normalizedId = normalizedCodexSessionId(sessionId);
  if (!normalizedId) return null;
  const sessions = cmuxSessions(["--session", normalizedId]);
  const exact = sessions.find((session) =>
    normalizedCodexSessionId(session.session_id ?? session.sessionId) === normalizedId);
  return exact ? sessionDetails(exact, normalizedId) : null;
}

function resolvedPendingCmuxHookSession() {
  const session = cmuxSessionForHook(pendingCmuxHookSessionId);
  if (session) pendingCmuxHookSessionId = null;
  return session;
}

function cmuxHookSession() {
  if (!options.cmuxSurface || !options.cmuxEvents) return null;
  let stat;
  try { stat = fs.statSync(options.cmuxEvents); } catch { return resolvedPendingCmuxHookSession(); }
  if (stat.size < cmuxEventPosition) {
    cmuxEventPosition = 0;
    cmuxEventPartialLine = "";
  }
  if (stat.size === cmuxEventPosition) return resolvedPendingCmuxHookSession();

  const descriptor = fs.openSync(options.cmuxEvents, "r");
  let text = cmuxEventPartialLine;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (cmuxEventPosition < stat.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - cmuxEventPosition),
        cmuxEventPosition,
      );
      if (bytesRead === 0) break;
      cmuxEventPosition += bytesRead;
      text += buffer.toString("utf8", 0, bytesRead);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const lines = text.split("\n");
  cmuxEventPartialLine = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!["agent.hook.SessionStart", "agent.hook.UserPromptSubmit"].includes(event.name)) continue;
    const surfaceId = event.surface_id ?? event.surfaceId
      ?? event.payload?.surface_id ?? event.payload?.surfaceId;
    if (surfaceId !== options.cmuxSurface) continue;
    pendingCmuxHookSessionId = event.payload?.session_id ?? event.payload?.sessionId
      ?? event.session_id ?? event.sessionId ?? pendingCmuxHookSessionId;
  }
  return resolvedPendingCmuxHookSession();
}

function readThrough(size) {
  if (size < position) {
    position = 0;
    partialLine = "";
  }
  if (size === position) return;

  const descriptor = fs.openSync(transcriptPath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (position < size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      consumeText(buffer.toString("utf8", 0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

if (transcriptPath) {
  try {
    readThrough(transcriptStat.size);
    loading = false;
  } catch (error) {
    process.stderr.write(`Could not load transcript: ${error.message}\n`);
    process.exit(1);
  }
}

let watcherBusy = false;
const watcher = setInterval(() => {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    if (!transcriptPath) return;
    readThrough(fs.statSync(transcriptPath).size);
  } catch (error) {
    for (const response of clients) sendEvent(response, "warning", { message: error.message });
  } finally {
    watcherBusy = false;
  }
}, 150);

let sessionPollBusy = false;
let lastSessionSwitchError = "";
const sessionPoll = options.cmuxSurface ? setInterval(() => {
  if (sessionPollBusy) return;
  sessionPollBusy = true;
  try {
    const nextSession = cmuxHookSession() ?? activeCmuxSession();
    if (nextSession && (!transcriptPath || path.resolve(nextSession.transcriptPath) !== transcriptPath)) {
      switchTranscript(nextSession.transcriptPath, nextSession.sessionId);
    }
    lastSessionSwitchError = "";
  } catch (error) {
    if (error.message !== lastSessionSwitchError) {
      process.stderr.write(`Could not switch the active Cmux transcript: ${error.message}\n`);
      lastSessionSwitchError = error.message;
    }
  } finally {
    sessionPollBusy = false;
  }
}, options.sessionPollMs ?? 500) : null;

const server = http.createServer((request, response) => {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");

  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" });
    response.end("Method not allowed\n");
    return;
  }

  if (request.url === "/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write("retry: 1000\n\n");
    sendEvent(response, "session", {
      sessionId: currentSessionId,
      transcript: transcriptPath ? path.basename(transcriptPath) : null,
      reason: "stream_snapshot",
    });
    for (const record of history) sendEvent(response, "record", record);
    sendEvent(response, "ready", {
      loading,
      sessionId: currentSessionId,
      transcript: transcriptPath ? path.basename(transcriptPath) : null,
      retainedEvents: history.length,
    });
    clients.add(response);
    request.on("close", () => {
      clients.delete(response);
      if (clients.size === 0) lastClientDisconnectedAt = Date.now();
    });
    return;
  }

  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
      status: "ok",
      sessionId: currentSessionId,
      transcript: transcriptPath ? path.basename(transcriptPath) : null,
      clients: clients.size,
      retainedEvents: history.length,
    })}\n`);
    return;
  }

  const staticFile = staticFiles.get(request.url);
  if (!staticFile) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  const [filePath, contentType] = staticFile;
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(response);
});

const keepAlive = setInterval(() => {
  for (const response of clients) response.write(": keep-alive\n\n");
}, 15_000);

const idleShutdown = options.exitIdle === undefined ? null : setInterval(() => {
  if (clients.size > 0) return;
  const idleSince = lastClientDisconnectedAt ?? serverStartedAt;
  if (Date.now() - idleSince < options.exitIdle * 1_000) return;
  cleanUp();
  process.exit(0);
}, 1_000);

server.listen(options.port, "127.0.0.1", () => {
  process.stdout.write(`Codex session tape: http://127.0.0.1:${options.port}/\n`);
  process.stdout.write(transcriptPath
    ? `Watching ${transcriptPath}\n`
    : `Waiting for a Codex session on Cmux surface ${options.cmuxSurface}\n`);
});

function cleanUp() {
  clearInterval(watcher);
  clearInterval(keepAlive);
  if (sessionPoll) clearInterval(sessionPoll);
  if (idleShutdown) clearInterval(idleShutdown);
  for (const response of clients) response.end();
  server.close();
}

process.on("SIGINT", () => {
  cleanUp();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanUp();
  process.exit(0);
});
