import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(moduleDirectory, "public");

function usage() {
  return `Usage: node web/server.mjs --transcript PATH [--port PORT] [--history COUNT]\n\n` +
    `Serves the transcript viewer on 127.0.0.1 only.\n`;
}

function parseArguments(argumentsList) {
  const values = { port: 4319, history: 250 };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--transcript") values.transcript = argumentsList[index += 1];
    else if (argument === "--port") values.port = Number.parseInt(argumentsList[index += 1], 10);
    else if (argument === "--history") values.history = Number.parseInt(argumentsList[index += 1], 10);
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
if (!options.transcript) {
  process.stderr.write(`--transcript is required.\n\n${usage()}`);
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

const transcriptPath = path.resolve(options.transcript);
let transcriptStat;
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
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const clients = new Set();
const history = [];
let position = 0;
let partialLine = "";
let loading = true;

function isRenderableRecord(record) {
  if (record?.type !== "event_msg") return false;
  return ["item_completed", "user_message", "agent_message"].includes(record.payload?.type);
}

function sendEvent(response, event, value) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function publishRecord(record, retain = true) {
  if (!isRenderableRecord(record)) return;
  if (retain && options.history > 0) {
    history.push(record);
    if (history.length > options.history) history.shift();
  }
  for (const response of clients) sendEvent(response, "record", record);
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

try {
  readThrough(transcriptStat.size);
  loading = false;
} catch (error) {
  process.stderr.write(`Could not load transcript: ${error.message}\n`);
  process.exit(1);
}

let watcherBusy = false;
const watcher = setInterval(() => {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    readThrough(fs.statSync(transcriptPath).size);
  } catch (error) {
    for (const response of clients) sendEvent(response, "warning", { message: error.message });
  } finally {
    watcherBusy = false;
  }
}, 150);

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
    for (const record of history) sendEvent(response, "record", record);
    sendEvent(response, "ready", {
      loading,
      transcript: path.basename(transcriptPath),
      retainedEvents: history.length,
    });
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
      status: "ok",
      transcript: path.basename(transcriptPath),
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

  const [fileName, contentType] = staticFile;
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(path.join(publicDirectory, fileName)).pipe(response);
});

const keepAlive = setInterval(() => {
  for (const response of clients) response.write(": keep-alive\n\n");
}, 15_000);

server.listen(options.port, "127.0.0.1", () => {
  process.stdout.write(`Codex session tape: http://127.0.0.1:${options.port}/\n`);
  process.stdout.write(`Watching ${transcriptPath}\n`);
});

function cleanUp() {
  clearInterval(watcher);
  clearInterval(keepAlive);
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
