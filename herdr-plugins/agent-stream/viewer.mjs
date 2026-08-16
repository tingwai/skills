import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const transcriptPath = process.env.CODEX_TRANSCRIPT_PATH;
const statePath = process.env.AGENT_STREAM_STATE_PATH;
const maxJsonStringLength = Number.parseInt(
  process.env.AGENT_STREAM_MAX_JSON_STRING_LENGTH ?? "500",
  10,
);
const maxJsonCollectionItems = Number.parseInt(
  process.env.AGENT_STREAM_MAX_JSON_COLLECTION_ITEMS ?? "100",
  10,
);

if (!transcriptPath) {
  process.stderr.write("CODEX_TRANSCRIPT_PATH is required.\n");
  process.exit(1);
}

const colorEnabled = !process.env.NO_COLOR && process.stdout.isTTY;
const color = (code, value) => colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : value;
let previousRenderedAt = null;

function formatElapsed(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const current = date.getTime();
  const totalSeconds = previousRenderedAt === null
    ? 0
    : Math.max(0, Math.round((current - previousRenderedAt) / 1_000));
  previousRenderedAt = current;

  if (totalSeconds >= 3_600) {
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    return `${hours}h${minutes}m`;
  }
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds}s`;
  }
  return `${totalSeconds}s`;
}

function heading(label, detail, code, timestamp) {
  const elapsed = formatElapsed(timestamp);
  const section = [label, detail].filter(Boolean).join("  ");
  const leadLength = section.length + (elapsed ? elapsed.length + 2 : 0);
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);
  const rule = "━".repeat(Math.max(3, width - leadLength - 1));
  const elapsedLabel = elapsed ? `${color("1;37", elapsed)}  ` : "";
  return `\n${elapsedLabel}${color(`1;${code}`, `${section} ${rule}`)}\n`;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (content.content !== undefined) return contentText(content.content);
  return "";
}

function shortenPath(value) {
  if (!value) return "";
  const normalized = value.startsWith("file://")
    ? decodeURIComponent(value.slice("file://".length))
    : value;
  const homeDirectory = os.homedir();
  if (normalized === homeDirectory) return "~";
  if (normalized.startsWith(`${homeDirectory}/`)) {
    return `~${normalized.slice(homeDirectory.length)}`;
  }
  return normalized;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command) {
  if (!Array.isArray(command)) return String(command ?? "");
  const executable = path.basename(command[0] ?? "");
  if (["bash", "dash", "sh", "zsh"].includes(executable) && ["-c", "-lc"].includes(command[1])) {
    return String(command[2] ?? "");
  }
  return command.map(shellQuote).join(" ");
}

function formatDuration(duration) {
  if (duration === null || duration === undefined) return "";
  const milliseconds = typeof duration === "number"
    ? duration * 1_000
    : (duration.secs ?? 0) * 1_000 + (duration.nanos ?? 0) / 1_000_000;
  if (milliseconds < 1) return "<1ms";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${(milliseconds / 60_000).toFixed(1)}m`;
}

function statusBadge(item) {
  const hasExitCode = Number.isInteger(item.exit_code);
  if (item.status === "completed" && (!hasExitCode || item.exit_code === 0)) return "✓";
  if (item.status === "failed" || (hasExitCode && item.exit_code !== 0)) return "✗";
  return item.status || "•";
}

function stripAnsi(value) {
  return String(value).replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

function truncateJsonValue(value, depth = 0) {
  if (typeof value === "string") {
    if (value.length <= maxJsonStringLength) return value;
    const omitted = value.length - maxJsonStringLength;
    return `${value.slice(0, maxJsonStringLength)}… [${omitted} chars truncated; ${value.length} total]`;
  }
  if (depth >= 12) return "… [maximum display depth reached]";
  if (Array.isArray(value)) {
    const displayed = value
      .slice(0, maxJsonCollectionItems)
      .map((item) => truncateJsonValue(item, depth + 1));
    if (value.length > maxJsonCollectionItems) {
      displayed.push(`… [${value.length - maxJsonCollectionItems} items truncated; ${value.length} total]`);
    }
    return displayed;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const displayed = Object.fromEntries(
      entries
        .slice(0, maxJsonCollectionItems)
        .map(([key, item]) => [key, truncateJsonValue(item, depth + 1)]),
    );
    if (entries.length > maxJsonCollectionItems) {
      displayed["…"] = `${entries.length - maxJsonCollectionItems} keys truncated; ${entries.length} total`;
    }
    return displayed;
  }
  return value;
}

function prettyJson(value) {
  const json = JSON.stringify(truncateJsonValue(value), null, 2);
  if (!colorEnabled) return json;

  return json.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu,
    (match, stringValue, keySuffix, booleanValue, nullValue, numberValue) => {
      if (stringValue && keySuffix) return `${color("1;36", stringValue)}${keySuffix}`;
      if (stringValue) return color("32", stringValue);
      if (booleanValue) return color("35", booleanValue);
      if (nullValue) return color("2", nullValue);
      if (numberValue) return color("33", numberValue);
      return match;
    },
  );
}

function formatOutput(value) {
  if (typeof value !== "string") return prettyJson(value);
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return prettyJson(JSON.parse(trimmed));
  } catch {
    // Some tools emit one complete JSON value per line instead of one document.
  }

  const lines = trimmed.split("\n").filter(Boolean);
  if (lines.length > 1) {
    try {
      return lines.map((line) => prettyJson(JSON.parse(line))).join("\n\n");
    } catch {
      // Preserve ordinary command output byte-for-byte when it is not JSONL.
    }
  }
  return value;
}

function writeBlock(label, detail, body, code = "37", bodyCode = null, timestamp = null) {
  process.stdout.write(heading(label, detail, code, timestamp));
  if (body) {
    const renderedBody = bodyCode ? color(bodyCode, body) : body;
    process.stdout.write(renderedBody.endsWith("\n") ? renderedBody : `${renderedBody}\n`);
  }
}

function renderCommand(item, timestamp) {
  const command = shellCommand(item.command);
  const status = [
    statusBadge(item),
    item.exit_code > 0 ? `exit ${item.exit_code}` : "",
    formatDuration(item.duration),
  ].filter(Boolean).join("  ");
  const invocation = [
    color("2", shortenPath(item.cwd)),
    color("1;33", `$ ${command.replaceAll("\n", "\n  ")}`),
  ].filter(Boolean).join("\n");

  writeBlock("COMMAND", status, invocation, "33", null, timestamp);

  const output = item.aggregated_output || item.formatted_output || item.stdout;
  const recursiveStreamRead = command.includes("herdr pane read")
    && /Codex stream ·|\b(?:COMMAND|OUTPUT|CODEX|USER)\b.*━{3}/u.test(stripAnsi(output));
  if (recursiveStreamRead) {
    writeBlock(
      "OUTPUT",
      "recursive stream read suppressed",
      "The complete result remains in the Codex transcript.",
      "36",
      "2",
    );
  } else if (output) {
    writeBlock("OUTPUT", "transcript output", formatOutput(output), "36");
  }
  if (item.stderr && !String(output ?? "").includes(item.stderr)) {
    writeBlock("STDERR", "", item.stderr, "31", "31");
  }
}

function renderFileChanges(changes) {
  const rendered = [];
  for (const [filePath, change] of Object.entries(changes ?? {})) {
    const diff = change.unified_diff ?? "";
    const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const symbol = { add: "A", delete: "D", move: "R", update: "M" }[change.type] ?? "M";
    const destination = change.move_path ? ` → ${shortenPath(change.move_path)}` : "";
    rendered.push(color("1;35", `${symbol} ${shortenPath(filePath)}${destination}  +${added} −${removed}`));
    if (diff) {
      for (const line of diff.trimEnd().split("\n")) {
        const code = line.startsWith("+") ? "32"
          : line.startsWith("-") ? "31"
            : line.startsWith("@@") ? "36"
              : "2";
        rendered.push(`  ${color(code, line)}`);
      }
    }
  }
  return rendered.join("\n");
}

function renderItem(item, timestamp) {
  switch (item.type) {
    case "UserMessage":
      writeBlock("USER", "", contentText(item.content), "34", "94", timestamp);
      break;
    case "AgentMessage":
      writeBlock("CODEX", item.phase, contentText(item.content), "32", "92", timestamp);
      break;
    case "CommandExecution":
      renderCommand(item, timestamp);
      break;
    case "Reasoning": {
      const summary = contentText(item.summary_text);
      if (summary) writeBlock("REASONING SUMMARY", "", summary, "35", "95", timestamp);
      break;
    }
    case "FileChange": {
      const fileCount = Object.keys(item.changes ?? {}).length;
      const detail = [statusBadge(item), `${fileCount} ${fileCount === 1 ? "file" : "files"}`].join("  ");
      writeBlock("FILE CHANGE", detail, renderFileChanges(item.changes), "35", null, timestamp);
      if (item.stderr) writeBlock("STDERR", "", item.stderr, "31", "31");
      break;
    }
    case "Extension": {
      const detail = [item.kind, item.query].filter(Boolean).join(" · ");
      writeBlock("EXTENSION", detail, formatOutput(item.results ?? item.action ?? item), "36", null, timestamp);
      break;
    }
    case "ContextCompaction":
      writeBlock("CONTEXT COMPACTED", "", "", "35", null, timestamp);
      break;
    default:
      writeBlock(item.type?.toUpperCase() ?? "ITEM", "", prettyJson(item), "37", null, timestamp);
  }
}

function renderRecord(record) {
  if (record?.type !== "event_msg") return;
  if (record.payload?.type === "item_completed" && record.payload.item) {
    renderItem(record.payload.item, record.timestamp);
    return;
  }
  if (record.payload?.type === "user_message") {
    writeBlock("USER", "", contentText(record.payload.message), "34", "94", record.timestamp);
  } else if (record.payload?.type === "agent_message") {
    writeBlock("CODEX", "", contentText(record.payload.message), "32", "92", record.timestamp);
  }
}

const sessionId = process.env.CODEX_SESSION_ID || path.basename(transcriptPath);
process.stdout.write(color("1;36", `Codex stream · ${sessionId}\n`));
process.stdout.write(color("2", `Watching ${transcriptPath}\n`));

if (statePath) {
  try {
    fs.writeFileSync(statePath, `${JSON.stringify({
      transcriptPath,
      sessionId: process.env.CODEX_SESSION_ID ?? "",
      pid: process.pid,
      openedAt: Date.now(),
    })}\n`);
  } catch (error) {
    process.stderr.write(`Could not update viewer state: ${error.message}\n`);
  }
}

let position = 0;
let partialLine = "";
try {
  position = fs.statSync(transcriptPath).size;
} catch (error) {
  process.stderr.write(`Could not read transcript: ${error.message}\n`);
}

function readNewRecords() {
  let descriptor;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size < position) {
      position = 0;
      partialLine = "";
    }
    if (size === position) return;

    descriptor = fs.openSync(transcriptPath, "r");
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
      partialLine += buffer.toString("utf8", 0, bytesRead);

      const lines = partialLine.split("\n");
      partialLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          renderRecord(JSON.parse(line));
        } catch (error) {
          writeBlock("PARSE ERROR", "", error.message, "31");
        }
      }
    }
  } catch (error) {
    process.stderr.write(`Transcript watcher error: ${error.message}\n`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const interval = setInterval(readNewRecords, 150);

function cleanUp() {
  clearInterval(interval);
  if (statePath) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (state.pid === process.pid) fs.unlinkSync(statePath);
    } catch {
      // A newer viewer may already own the state file.
    }
  }
}

process.on("SIGINT", () => {
  cleanUp();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanUp();
  process.exit(0);
});
process.on("exit", cleanUp);
