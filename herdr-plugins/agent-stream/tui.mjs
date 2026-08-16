import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const transcriptPath = process.env.CODEX_TRANSCRIPT_PATH;
const statePath = process.env.AGENT_STREAM_STATE_PATH;
const historyLimit = positiveInteger(process.env.AGENT_STREAM_TUI_HISTORY, 250);
const eventLimit = positiveInteger(process.env.AGENT_STREAM_TUI_MAX_EVENTS, 500);
const eventLineLimit = positiveInteger(process.env.AGENT_STREAM_TUI_MAX_EVENT_LINES, 2_000);
const tailByteLimit = positiveInteger(process.env.AGENT_STREAM_TUI_TAIL_BYTES, 64 * 1024 * 1024);
const maxJsonStringLength = positiveInteger(process.env.AGENT_STREAM_MAX_JSON_STRING_LENGTH, 500);
const maxJsonCollectionItems = positiveInteger(process.env.AGENT_STREAM_MAX_JSON_COLLECTION_ITEMS, 100);

if (!transcriptPath) {
  process.stderr.write("CODEX_TRANSCRIPT_PATH is required.\n");
  process.exit(1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("The interactive viewer requires a TTY. Use viewer.mjs for plain output.\n");
  process.exit(1);
}

const CSI = "\u001b[";
const RESET = `${CSI}0m`;
const kindColors = {
  user: "94", agent: "92", command: "93", file: "95", extension: "96",
  reasoning: "95", error: "91", other: "97",
};

const state = {
  events: [],
  selectedIndex: -1,
  scrollOffset: 0,
  transcriptPosition: 0,
  partialLine: "",
  following: true,
  renderedDocument: [],
  visibleRows: new Map(),
  shiftWheelDirection: 0,
  shiftWheelSkipNext: false,
  interval: null,
  cleanedUp: false,
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  return content.content === undefined ? "" : contentText(content.content);
}

function shortenPath(value) {
  if (!value) return "";
  const normalized = value.startsWith("file://")
    ? decodeURIComponent(value.slice("file://".length))
    : value;
  const homeDirectory = os.homedir();
  if (normalized === homeDirectory) return "~";
  return normalized.startsWith(`${homeDirectory}/`)
    ? `~${normalized.slice(homeDirectory.length)}`
    : normalized;
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

function formatElapsed(current, previous) {
  if (current === null || previous === null) return "0s";
  const seconds = Math.max(0, Math.round((current - previous) / 1_000));
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTypeLabel(value) {
  const label = String(value ?? "")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .trim();
  return label ? label.toUpperCase() : "ITEM";
}

function truncateJsonValue(value, depth = 0) {
  if (typeof value === "string") {
    if (value.length <= maxJsonStringLength) return value;
    return `${value.slice(0, maxJsonStringLength)}… [${value.length - maxJsonStringLength} chars truncated]`;
  }
  if (depth >= 12) return "… [maximum display depth reached]";
  if (Array.isArray(value)) {
    const displayed = value.slice(0, maxJsonCollectionItems)
      .map((item) => truncateJsonValue(item, depth + 1));
    if (value.length > maxJsonCollectionItems) {
      displayed.push(`… [${value.length - maxJsonCollectionItems} items truncated]`);
    }
    return displayed;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const displayed = Object.fromEntries(entries.slice(0, maxJsonCollectionItems)
      .map(([key, item]) => [key, truncateJsonValue(item, depth + 1)]));
    if (entries.length > maxJsonCollectionItems) {
      displayed["…"] = `${entries.length - maxJsonCollectionItems} keys truncated`;
    }
    return displayed;
  }
  return value;
}

function outputLines(value, role = "output") {
  if (typeof value !== "string") {
    return JSON.stringify(truncateJsonValue(value), null, 2).split("\n")
      .map((text) => ({ text, role: "json" }));
  }
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    return JSON.stringify(truncateJsonValue(JSON.parse(trimmed)), null, 2).split("\n")
      .map((text) => ({ text, role: "json" }));
  } catch {
    // Preserve ordinary command output.
  }
  return value.split("\n").map((text) => ({ text, role }));
}

function bodyLines(text, role) {
  return String(text ?? "").split("\n").map((line) => ({ text: line, role }));
}

function fileChangeLines(changes) {
  const lines = [];
  for (const [filePath, change] of Object.entries(changes ?? {})) {
    const diff = change.unified_diff ?? "";
    const diffLines = diff.split("\n");
    const added = diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = diffLines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const symbol = { add: "A", delete: "D", move: "R", update: "M" }[change.type] ?? "M";
    const destination = change.move_path ? ` → ${shortenPath(change.move_path)}` : "";
    lines.push({ text: `${symbol} ${shortenPath(filePath)}${destination}  +${added} −${removed}`, role: "file" });
    for (const line of diff.trimEnd().split("\n")) {
      if (!line) continue;
      const role = line.startsWith("+") ? "add"
        : line.startsWith("-") ? "remove"
          : line.startsWith("@@") ? "hunk" : "meta";
      lines.push({ text: `  ${line}`, role });
    }
  }
  return lines;
}

function itemToEvent(item, timestamp) {
  const timestampMs = Date.parse(timestamp ?? "");
  const base = { timestampMs: Number.isNaN(timestampMs) ? null : timestampMs, detail: "", lines: [] };
  switch (item.type) {
    case "UserMessage":
      return { ...base, kind: "user", label: "USER", lines: bodyLines(contentText(item.content), "user") };
    case "AgentMessage":
      return { ...base, kind: "agent", label: "CODEX", detail: item.phase ?? "", lines: bodyLines(contentText(item.content), "agent") };
    case "CommandExecution": {
      const command = shellCommand(item.command);
      const detail = [statusBadge(item), item.exit_code > 0 ? `exit ${item.exit_code}` : "", formatDuration(item.duration)]
        .filter(Boolean).join("  ");
      const lines = [];
      if (item.cwd) lines.push({ text: shortenPath(item.cwd), role: "meta" });
      lines.push(...bodyLines(`$ ${command}`, "command"));
      const output = item.aggregated_output || item.formatted_output || item.stdout;
      const recursiveRead = command.includes("herdr pane read")
        && /Codex stream ·|\b(?:COMMAND|OUTPUT|CODEX|USER)\b.*━{3}/u.test(String(output ?? ""));
      if (recursiveRead) {
        lines.push({ text: "recursive stream read suppressed; full result remains in transcript", role: "meta" });
      } else if (output) {
        lines.push({ text: "OUTPUT", role: "output-heading" }, ...outputLines(output));
      }
      if (item.stderr && !String(output ?? "").includes(item.stderr)) {
        lines.push({ text: "STDERR", role: "error" }, ...bodyLines(item.stderr, "error"));
      }
      return { ...base, kind: "command", label: "COMMAND", detail, lines };
    }
    case "Reasoning": {
      const summary = contentText(item.summary_text);
      return summary ? { ...base, kind: "reasoning", label: "REASONING", lines: bodyLines(summary, "reasoning") } : null;
    }
    case "FileChange": {
      const fileCount = Object.keys(item.changes ?? {}).length;
      const detail = `${statusBadge(item)}  ${fileCount} ${fileCount === 1 ? "file" : "files"}`;
      const lines = fileChangeLines(item.changes);
      if (item.stderr) lines.push(...bodyLines(item.stderr, "error"));
      return { ...base, kind: "file", label: "FILE CHANGE", detail, lines };
    }
    case "Extension":
      return { ...base, kind: "extension", label: "EXTENSION", detail: [item.kind, item.query].filter(Boolean).join(" · "), lines: outputLines(item.results ?? item.action ?? item) };
    case "ContextCompaction":
      return { ...base, kind: "reasoning", label: "CONTEXT COMPACTED" };
    default: {
      const detail = [item.status ? statusBadge(item) : "", formatDuration(item.duration)]
        .filter(Boolean).join("  ");
      return {
        ...base,
        kind: "other",
        label: formatTypeLabel(item.type),
        detail,
        lines: outputLines(item),
      };
    }
  }
}

function recordToEvent(record) {
  if (record?.type !== "event_msg") return null;
  if (record.payload?.type === "item_completed" && record.payload.item) {
    return itemToEvent(record.payload.item, record.timestamp);
  }
  if (record.payload?.type === "user_message") {
    return itemToEvent({ type: "UserMessage", content: record.payload.message }, record.timestamp);
  }
  if (record.payload?.type === "agent_message") {
    return itemToEvent({ type: "AgentMessage", content: record.payload.message }, record.timestamp);
  }
  return null;
}

function appendEvent(event) {
  if (!event) return false;
  const previous = state.events.at(-1)?.timestampMs ?? null;
  event.elapsed = formatElapsed(event.timestampMs, previous);
  if (event.lines.length > eventLineLimit) {
    const omitted = event.lines.length - eventLineLimit;
    event.lines = [...event.lines.slice(0, eventLineLimit), { text: `… ${omitted} more lines remain in the transcript`, role: "meta" }];
  }
  state.events.push(event);
  if (state.events.length > eventLimit) {
    const removed = state.events.length - eventLimit;
    state.events.splice(0, removed);
    state.selectedIndex = Math.max(-1, state.selectedIndex - removed);
  }
  if (state.following || state.selectedIndex < 0) state.selectedIndex = state.events.length - 1;
  return true;
}

function loadHistory() {
  try {
    const size = fs.statSync(transcriptPath).size;
    state.transcriptPosition = size;
    const start = Math.max(0, size - tailByteLimit);
    const length = size - start;
    if (length === 0) return;
    const descriptor = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    fs.closeSync(descriptor);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const parsed = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const event = recordToEvent(JSON.parse(line));
        if (event) parsed.push(event);
      } catch {
        // A concurrently appended partial line will be retried by the live reader.
      }
    }
    for (const event of parsed.slice(-historyLimit)) appendEvent(event);
    state.selectedIndex = state.events.length - 1;
  } catch (error) {
    state.events.push({ timestampMs: null, elapsed: "0s", kind: "error", label: "TRANSCRIPT ERROR", detail: "", lines: bodyLines(error.message, "error") });
    state.selectedIndex = 0;
  }
}

function wrapText(value, width) {
  const text = String(value).replaceAll("\t", "  ");
  if (text.length <= width) return [text];
  const wrapped = [];
  let remaining = text;
  while (remaining.length > width) {
    let boundary = remaining.lastIndexOf(" ", width);
    if (boundary < Math.floor(width * 0.45)) boundary = width;
    wrapped.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  wrapped.push(remaining);
  return wrapped;
}

function buildDocument(width) {
  const document = [];
  for (const [eventIndex, event] of state.events.entries()) {
    const marker = eventIndex === state.selectedIndex ? "▌" : "│";
    const detail = event.detail ? `  ${event.detail}` : "";
    document.push({
      text: `${marker} ${event.elapsed.padEnd(6)} ${event.label}${detail}`,
      role: `header-${event.kind}`,
      eventIndex,
      isHeader: true,
      headerParts: { marker, elapsed: event.elapsed, label: event.label, detail: event.detail },
    });
    for (const line of event.lines) {
      const wrappedParts = wrapText(line.text, Math.max(8, width - 4));
      for (const [partIndex, part] of wrappedParts.entries()) {
        document.push({
          text: `   ${part}`,
          role: line.role,
          eventIndex,
          isHeader: false,
          shellContinuation: line.role === "command" && partIndex > 0,
        });
      }
    }
    document.push({ text: "", role: "blank", eventIndex, isHeader: false });
  }
  return document;
}

function roleColor(role) {
  if (role.startsWith("header-")) return kindColors[role.slice(7)] ?? kindColors.other;
  return { user: "94", agent: "92", command: "93", output: "37", "output-heading": "1;96", json: "36", file: "95", add: "32", remove: "31", hunk: "36", meta: "2", reasoning: "95", error: "91", blank: "0" }[role] ?? "37";
}

function headerStyle(kind) {
  const foreground = Number(kindColors[kind] ?? kindColors.other);
  return `38;2;0;0;0;${foreground + 10}`;
}

function clip(value, width) {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}

function shellTokenRole(token, tokenizerState) {
  if (/^\s+$/u.test(token)) return "space";
  if (token === "$" && tokenizerState.commandExpected) return "prompt";
  if (["&&", "||", "|", ";", "&", "(", ")", "<", ">", "<<", ">>"].includes(token)) {
    if (["&&", "||", "|", ";", "&"].includes(token)) {
      tokenizerState.commandExpected = true;
      tokenizerState.subcommandExpected = false;
    }
    if (["<", ">", "<<", ">>"].includes(token)) tokenizerState.redirectTarget = true;
    return "operator";
  }
  if (/^(?:"(?:\\.|[^"\\])*"|'[^']*'|`(?:\\.|[^`\\])*`)$/u.test(token)) {
    return "string";
  }
  if (tokenizerState.commandExpected && /^[a-zA-Z_][a-zA-Z0-9_]*=.*/u.test(token)) return "assignment";
  if (tokenizerState.commandExpected) {
    tokenizerState.commandExpected = false;
    tokenizerState.subcommandExpected = true;
    return "executable";
  }
  if (/^-{1,2}[^-]/u.test(token)) return "flag";
  if (tokenizerState.redirectTarget || /^(?:~?\/|\.{1,2}\/|file:\/\/)/u.test(token) || token.includes("/")) {
    tokenizerState.redirectTarget = false;
    return "path";
  }
  if (/^\$\{?[a-zA-Z_]/u.test(token)) return "variable";
  if (tokenizerState.subcommandExpected) {
    tokenizerState.subcommandExpected = false;
    return "subcommand";
  }
  return "argument";
}

function paintShellCommand(entry, width, baseStyle) {
  const text = clip(entry.text, width);
  const tokenPattern = /(\s+|&&|\|\||<<|>>|[|;&()<>]|"(?:\\.|[^"\\])*"|'[^']*'|`(?:\\.|[^`\\])*`|[^\s|&;()<>]+)/gu;
  const tokenizerState = {
    commandExpected: !entry.shellContinuation,
    subcommandExpected: false,
    redirectTarget: false,
  };
  const styles = {
    space: "22;23;37",
    prompt: "2;23;37",
    executable: "1;23;33",
    subcommand: "1;23;97",
    flag: "22;3;36",
    path: "22;3;94",
    string: "22;3;32",
    operator: "1;23;35",
    assignment: "22;3;95",
    variable: "22;3;95",
    argument: "22;23;37",
  };
  let rendered = "";
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    rendered += `${CSI}${styles[shellTokenRole(token, tokenizerState)]}m${token}`;
  }
  return `${baseStyle}${rendered}${baseStyle}${" ".repeat(width - text.length)}${RESET}`;
}

function paint(entry, width) {
  const userSection = state.events[entry.eventIndex]?.kind === "user";
  const bodyBackground = entry.eventIndex === state.selectedIndex
    ? userSection ? "48;2;38;44;49;" : "48;5;236;"
    : userSection ? "48;2;25;29;33;" : "";
  const headerKind = entry.role.startsWith("header-") ? entry.role.slice("header-".length) : "other";
  const baseStyle = entry.isHeader
    ? `${CSI}22;23;${headerStyle(headerKind)}m`
    : `${CSI}22;23;${bodyBackground}${roleColor(entry.role)}m`;
  if (!entry.isHeader) {
    if (entry.role === "command") return paintShellCommand(entry, width, baseStyle);
    return `${baseStyle}${clip(entry.text, width).padEnd(width)}${RESET}`;
  }

  const { marker, elapsed, label, detail } = entry.headerParts;
  const segments = [
    { text: `${marker} `, bold: false },
    { text: elapsed.padEnd(6), bold: true },
    { text: " ", bold: false },
    { text: label, bold: true },
    { text: detail ? `  ${detail}` : "", bold: false },
  ];
  let remaining = width;
  let rendered = "";
  for (const segment of segments) {
    if (remaining <= 0) break;
    const text = segment.text.slice(0, remaining);
    rendered += segment.bold ? `${CSI}1m${text}${CSI}22m` : text;
    remaining -= text.length;
  }
  return `${baseStyle}${rendered}${" ".repeat(remaining)}${RESET}`;
}

function eventRange(index, document = state.renderedDocument) {
  const first = document.findIndex((entry) => entry.eventIndex === index);
  if (first < 0) return { first: 0, last: 0 };
  let last = first;
  while (last + 1 < document.length && document[last + 1].eventIndex === index) last += 1;
  return { first, last };
}

function contentHeight() {
  return Math.max(1, (process.stdout.rows ?? 24) - 2);
}

function scrollToSelected(positionMode = "top") {
  state.renderedDocument = buildDocument(Math.max(20, (process.stdout.columns ?? 80) - 1));
  const range = eventRange(state.selectedIndex);
  state.scrollOffset = positionMode === "bottom" ? Math.max(0, range.last - contentHeight() + 1) : range.first;
}

function selectRelative(delta) {
  if (!state.events.length) return;
  state.following = false;
  state.selectedIndex = Math.max(0, Math.min(state.events.length - 1, state.selectedIndex + delta));
  scrollToSelected();
  render();
}

function scrollConversation(delta) {
  state.following = false;
  state.renderedDocument = buildDocument(Math.max(20, (process.stdout.columns ?? 80) - 1));
  const maximum = Math.max(0, state.renderedDocument.length - contentHeight());
  state.scrollOffset = Math.max(0, Math.min(maximum, state.scrollOffset + delta));
  if (state.scrollOffset === maximum && state.events.length) {
    state.following = true;
    state.selectedIndex = state.events.length - 1;
  }
  render();
}

function selectRelativeFromWheel(direction) {
  if (state.shiftWheelDirection !== direction) {
    state.shiftWheelDirection = direction;
    state.shiftWheelSkipNext = false;
  }
  if (state.shiftWheelSkipNext) {
    state.shiftWheelSkipNext = false;
    return;
  }
  state.shiftWheelSkipNext = true;
  selectRelative(direction);
}

function render() {
  const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
  const height = Math.max(6, process.stdout.rows ?? 24);
  const viewportHeight = Math.max(1, height - 2);
  state.renderedDocument = buildDocument(width);
  state.scrollOffset = Math.max(0, Math.min(Math.max(0, state.renderedDocument.length - viewportHeight), state.scrollOffset));
  state.visibleRows = new Map();
  const sessionId = process.env.CODEX_SESSION_ID || path.basename(transcriptPath);
  const help = clip(" click selects · wheel scrolls chat · Shift+wheel message · j/k · G live", width).padEnd(width);
  const output = [`${CSI}H${CSI}2J${CSI}2;37m${help}${RESET}`];
  for (let offset = 0; offset < viewportHeight; offset += 1) {
    const documentIndex = state.scrollOffset + offset;
    const entry = state.renderedDocument[documentIndex];
    const terminalRow = offset + 2;
    if (entry) state.visibleRows.set(terminalRow, entry);
    output.push(entry ? paint(entry, width) : " ".repeat(width));
  }
  if (state.events.length) {
    const statusLabel = state.following ? "LIVE" : "PAUSED";
    const stateSegment = state.following ? ` ${statusLabel} ` : statusLabel;
    const prefix = ` ${state.selectedIndex + 1}/${state.events.length} · `;
    const status = clip(`${prefix}${stateSegment} · session ${sessionId} `, width).padEnd(width);
    const beforeState = status.slice(0, prefix.length);
    const renderedState = status.slice(prefix.length, prefix.length + stateSegment.length);
    const afterState = status.slice(prefix.length + stateSegment.length);
    const stateStyle = state.following ? `${CSI}1;38;2;0;0;0;48;2;255;255;255m` : "";
    const restoreStyle = state.following ? `${RESET}${CSI}38;5;246m` : "";
    output.push(`${CSI}38;5;246m${beforeState}${stateStyle}${renderedState}${restoreStyle}${afterState}${RESET}`);
  } else {
    output.push(`${CSI}38;5;246m${clip(" Waiting for renderable transcript events… ", width).padEnd(width)}${RESET}`);
  }
  process.stdout.write(output.join("\n"));
}

function handleMouse(code, row, suffix) {
  if (suffix !== "M") return;
  if ((code & 64) !== 0) {
    const direction = (code & 1) === 0 ? -1 : 1;
    if ((code & 4) !== 0) {
      selectRelativeFromWheel(direction);
    } else {
      state.shiftWheelDirection = 0;
      state.shiftWheelSkipNext = false;
      scrollConversation(direction * 3);
    }
    return;
  }
  if ((code & 3) !== 0) return;
  const hit = state.visibleRows.get(row);
  if (!hit) return;
  state.following = false;
  state.selectedIndex = hit.eventIndex;
  render();
}

function handleInput(data) {
  const input = data.toString("utf8");
  const mousePattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/gu;
  let match;
  let keyboard = input;
  while ((match = mousePattern.exec(input)) !== null) {
    handleMouse(Number(match[1]), Number(match[3]), match[4]);
    keyboard = keyboard.replace(match[0], "");
  }
  if (!keyboard) return;
  if (keyboard === "q" || keyboard === "\u0003") cleanUpAndExit();
  else if (keyboard === "k" || keyboard === "\u001b[A") selectRelative(-1);
  else if (keyboard === "j" || keyboard === "\u001b[B") selectRelative(1);
  else if (keyboard === "G") {
    state.following = true;
    state.selectedIndex = state.events.length - 1;
    scrollToSelected("bottom");
    render();
  } else if (keyboard === "g") {
    state.following = false;
    state.selectedIndex = state.events.length ? 0 : -1;
    scrollToSelected();
    render();
  }
}

function readNewRecords() {
  let descriptor;
  let changed = false;
  try {
    const size = fs.statSync(transcriptPath).size;
    if (size < state.transcriptPosition) {
      state.transcriptPosition = 0;
      state.partialLine = "";
      state.events = [];
      state.selectedIndex = -1;
    }
    if (size === state.transcriptPosition) return;
    descriptor = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (state.transcriptPosition < size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, size - state.transcriptPosition),
        state.transcriptPosition,
      );
      if (bytesRead === 0) break;
      state.transcriptPosition += bytesRead;
      state.partialLine += buffer.toString("utf8", 0, bytesRead);
      const lines = state.partialLine.split("\n");
      state.partialLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          changed = appendEvent(recordToEvent(JSON.parse(line))) || changed;
        } catch {
          // Ignore malformed records; the source transcript remains authoritative.
        }
      }
    }
  } catch {
    // Keep the TUI usable while a transcript is briefly unavailable.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (changed) {
    if (state.following) scrollToSelected("bottom");
    render();
  }
}

function writeState() {
  if (!statePath) return;
  try {
    fs.writeFileSync(statePath, `${JSON.stringify({ transcriptPath, sessionId: process.env.CODEX_SESSION_ID ?? "", pid: process.pid, openedAt: Date.now() })}\n`);
  } catch {
    // The viewer can continue if deduplication state is unavailable.
  }
}

function cleanUp() {
  if (state.cleanedUp) return;
  state.cleanedUp = true;
  if (state.interval) clearInterval(state.interval);
  process.stdin.off("data", handleInput);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(`${CSI}?1000l${CSI}?1006l${CSI}?25h${CSI}?1049l`);
  if (statePath) {
    try {
      const viewerState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (viewerState.pid === process.pid) fs.unlinkSync(statePath);
    } catch {
      // A newer viewer may own the state file.
    }
  }
}

function cleanUpAndExit() {
  cleanUp();
  process.exit(0);
}

loadHistory();
writeState();
process.stdout.write(`${CSI}?1049h${CSI}?25l${CSI}?1000h${CSI}?1006h`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", handleInput);
process.stdout.on("resize", render);
process.on("SIGINT", cleanUpAndExit);
process.on("SIGTERM", cleanUpAndExit);
process.on("exit", cleanUp);
scrollToSelected("bottom");
render();
state.interval = setInterval(readNewRecords, 150);
