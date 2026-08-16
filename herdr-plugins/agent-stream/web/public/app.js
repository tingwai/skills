const MAX_JSON_STRING_LENGTH = 500;
const MAX_JSON_COLLECTION_ITEMS = 100;
const MAX_JSON_DEPTH = 12;
const FILTERS = ["user", "agent", "command", "reasoning", "change", "extension", "other"];

const tape = document.querySelector("#tape");
const emptyState = document.querySelector("#empty");
const connection = document.querySelector("#connection");
const sessionName = document.querySelector("#session-name");
const searchInput = document.querySelector("#search");
const filtersElement = document.querySelector("#filters");
const pauseButton = document.querySelector("#pause");
const jumpButton = document.querySelector("#jump-live");
const notice = document.querySelector("#notice");
const filterCounts = new Map(FILTERS.map((filter) => [filter, 0]));
const activeFilters = new Set(FILTERS);
let follow = true;
let connected = false;
let previousRenderedAt = null;
let selectedEvent = null;
let transcriptLabel = "Waiting for transcript";
let lastShiftWheelAt = 0;
let lastShiftWheelDirection = 0;

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatElapsed(value) {
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
    return `${minutes}m${totalSeconds % 60}s`;
  }
  return `${totalSeconds}s`;
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
  let normalized = value;
  if (normalized.startsWith("file://")) {
    try { normalized = decodeURIComponent(normalized.slice("file://".length)); } catch { /* Keep input. */ }
  }
  const homeMatch = normalized.match(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u);
  return homeMatch ? `~${normalized.slice(homeMatch[0].length)}` : normalized;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command) {
  if (!Array.isArray(command)) return String(command ?? "");
  const executable = String(command[0] ?? "").split("/").at(-1);
  if (["bash", "dash", "sh", "zsh"].includes(executable) && ["-c", "-lc"].includes(command[1])) {
    return String(command[2] ?? "");
  }
  return command.map(shellQuote).join(" ");
}

function shellTokenRole(token, tokenizerState) {
  if (/^\s+$/u.test(token)) {
    if (token.includes("\n")) {
      tokenizerState.commandExpected = true;
      tokenizerState.subcommandExpected = false;
      tokenizerState.redirectTarget = false;
    }
    return "space";
  }
  if (token === "$" && tokenizerState.commandExpected) return "prompt";
  if (["&&", "||", "|", ";", "&", "(", ")", "<", ">", "<<", ">>"].includes(token)) {
    if (["&&", "||", "|", ";", "&"].includes(token)) {
      tokenizerState.commandExpected = true;
      tokenizerState.subcommandExpected = false;
    }
    if (["<", ">", "<<", ">>"].includes(token)) tokenizerState.redirectTarget = true;
    return "operator";
  }
  if (/^(?:"(?:\\.|[^"\\])*"|'[^']*'|`(?:\\.|[^`\\])*`)$/u.test(token)) return "string";
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

function shellCommandNode(command) {
  const node = element("pre", "command-line");
  const tokenizerState = { commandExpected: true, subcommandExpected: false, redirectTarget: false };
  const source = `$ ${command.replaceAll("\n", "\n  ")}`;
  const tokenPattern = /(\s+|&&|\|\||<<|>>|[|;&()<>]|"(?:\\.|[^"\\])*"|'[^']*'|`(?:\\.|[^`\\])*`|[^\s|&;()<>]+)/gu;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const role = shellTokenRole(token, tokenizerState);
    if (role === "space") node.append(document.createTextNode(token));
    else node.append(element("span", `shell-token shell-${role}`, token));
  }
  return node;
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

function stripAnsi(value) {
  return String(value).replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

function itemTypeLabel(value) {
  const type = String(value ?? "").trim();
  if (!type) return "ITEM";
  return type
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/[_-]+/gu, " ")
    .toUpperCase();
}

function addBadge(container, value, className = "") {
  if (!value) return;
  container.append(element("span", `badge ${className}`.trim(), value));
}

function scalarNode(value) {
  if (typeof value === "string") {
    if (value.length <= MAX_JSON_STRING_LENGTH) {
      return element("span", "json-string", JSON.stringify(value));
    }
    const details = element("details", "long-value");
    const omitted = value.length - MAX_JSON_STRING_LENGTH;
    details.append(element(
      "summary",
      "json-string",
      `${JSON.stringify(`${value.slice(0, MAX_JSON_STRING_LENGTH)}…`)} ` +
        `[${omitted} chars hidden; ${value.length} total]`,
    ));
    details.append(element("pre", "", value));
    return details;
  }
  if (typeof value === "number") return element("span", "json-number", String(value));
  if (typeof value === "boolean") return element("span", "json-boolean", String(value));
  return element("span", "json-null", "null");
}

function jsonNode(value, depth = 0) {
  if (value === null || typeof value !== "object") return scalarNode(value);
  if (depth >= MAX_JSON_DEPTH) return element("span", "json-more", "… maximum display depth");

  const container = element("div", "json-tree");
  const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
  const displayedEntries = entries.slice(0, MAX_JSON_COLLECTION_ITEMS);
  container.append(element("span", "json-punctuation", Array.isArray(value) ? "[" : "{"));
  for (const [key, childValue] of displayedEntries) {
    const row = element("div", "json-row");
    if (!Array.isArray(value)) {
      row.append(element("span", "json-key", JSON.stringify(key)));
      row.append(element("span", "json-punctuation", ": "));
    } else {
      row.append(element("span", "json-punctuation", `${key}: `));
    }
    row.append(jsonNode(childValue, depth + 1));
    row.append(element("span", "json-punctuation", ","));
    container.append(row);
  }
  if (entries.length > MAX_JSON_COLLECTION_ITEMS) {
    const details = element("details", "json-row json-more");
    details.append(element(
      "summary",
      "",
      `${entries.length - MAX_JSON_COLLECTION_ITEMS} more ${Array.isArray(value) ? "items" : "keys"} ` +
        `(${entries.length} total)`,
    ));
    for (const [key, childValue] of entries.slice(MAX_JSON_COLLECTION_ITEMS)) {
      const row = element("div", "json-row");
      row.append(element("span", "json-key", Array.isArray(value) ? `${key}: ` : `${JSON.stringify(key)}: `));
      row.append(jsonNode(childValue, depth + 1));
      details.append(row);
    }
    container.append(details);
  }
  container.append(element("span", "json-punctuation", Array.isArray(value) ? "]" : "}"));
  return container;
}

function formattedOutput(value) {
  if (typeof value !== "string") return jsonNode(value);
  const trimmed = value.trim();
  if (!trimmed) return element("pre", "", value);
  try { return jsonNode(JSON.parse(trimmed)); } catch { /* Try JSONL below. */ }

  const lines = trimmed.split("\n").filter(Boolean);
  if (lines.length > 1) {
    try {
      const fragment = document.createDocumentFragment();
      for (const line of lines) fragment.append(jsonNode(JSON.parse(line)));
      return fragment;
    } catch { /* Preserve ordinary output. */ }
  }
  return element("pre", "", value);
}

function eventShell(kind, label, detail, timestamp) {
  const item = element("li", `event ${kind}`);
  item.dataset.kind = kind;
  const header = element("header", "event-header");
  const time = element("time", "event-time", formatElapsed(timestamp));
  time.title = "Elapsed since the previous displayed event";
  header.append(time);
  header.append(element("span", "header-marker"));
  header.append(element("span", "event-label", label));
  if (detail) header.append(element("span", "event-detail", detail));
  const badges = element("div", "badges");
  header.append(badges);
  item.append(header);

  const content = element("div", "event-content");
  content.append(element("span", "rail"));
  const card = element("article", "event-card");
  const body = element("div", "event-body");
  card.append(body);
  content.append(card);
  item.append(content);
  return { item, body, badges };
}

function commandEvent(item, timestamp) {
  const command = shellCommand(item.command);
  const shell = eventShell("command", "Command", "", timestamp);
  const hasExitCode = Number.isInteger(item.exit_code);
  const successful = item.status === "completed" && (!hasExitCode || item.exit_code === 0);
  const failed = item.status === "failed" || (hasExitCode && item.exit_code !== 0);
  addBadge(shell.badges, successful ? "✓ completed" : failed ? "✕ failed" : item.status || "running", successful ? "success" : failed ? "failure" : "");
  addBadge(shell.badges, hasExitCode ? `exit ${item.exit_code}` : "", item.exit_code === 0 ? "success" : "failure");
  addBadge(shell.badges, formatDuration(item.duration));
  if (item.cwd) shell.body.append(element("p", "path", shortenPath(item.cwd)));
  shell.body.append(shellCommandNode(command));

  const output = item.aggregated_output || item.formatted_output || item.stdout;
  const recursiveStreamRead = command.includes("herdr pane read") &&
    /Codex stream ·|\b(?:COMMAND|OUTPUT|CODEX|USER)\b.*━{3}/u.test(stripAnsi(output));
  if (output) {
    const group = element("section", "output-group");
    group.append(element("p", "output-label", recursiveStreamRead ? "Output suppressed" : "Output"));
    if (recursiveStreamRead) {
      group.append(element("p", "suppressed", "Recursive stream read hidden. The complete result remains in the source transcript."));
    } else {
      group.append(formattedOutput(output));
    }
    shell.body.append(group);
  }
  if (item.stderr && !String(output ?? "").includes(item.stderr)) {
    const group = element("section", "output-group");
    group.append(element("p", "output-label", "Stderr"));
    group.append(element("pre", "stderr", item.stderr));
    shell.body.append(group);
  }
  return shell.item;
}

function fileChangeEvent(item, timestamp) {
  const changes = Object.entries(item.changes ?? {});
  const shell = eventShell("change", "File change", `${changes.length} ${changes.length === 1 ? "file" : "files"}`, timestamp);
  addBadge(shell.badges, item.status === "completed" ? "✓ completed" : item.status, item.status === "completed" ? "success" : "");
  for (const [filePath, change] of changes) {
    const diff = change.unified_diff ?? "";
    const lines = diff.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const symbol = { add: "A", delete: "D", move: "R", update: "M" }[change.type] ?? "M";
    const destination = change.move_path ? ` → ${shortenPath(change.move_path)}` : "";
    shell.body.append(element("p", "file-summary", `${symbol} ${shortenPath(filePath)}${destination}  +${added} −${removed}`));
    const diffNode = element("div", "diff");
    for (const line of lines) {
      const className = line.startsWith("+") && !line.startsWith("+++") ? "add"
        : line.startsWith("-") && !line.startsWith("---") ? "remove"
          : line.startsWith("@@") ? "hunk" : "meta";
      diffNode.append(element("span", `diff-line ${className}`, line));
    }
    shell.body.append(diffNode);
  }
  return shell.item;
}

function renderRecord(record) {
  if (record?.type !== "event_msg") return null;
  let item = record.payload?.item;
  if (record.payload?.type === "user_message") item = { type: "UserMessage", content: record.payload.message };
  if (record.payload?.type === "agent_message") item = { type: "AgentMessage", content: record.payload.message };
  if (!item) return null;

  if (item.type === "CommandExecution") return commandEvent(item, record.timestamp);
  if (item.type === "FileChange") return fileChangeEvent(item, record.timestamp);

  const definitions = {
    UserMessage: ["user", "User", ""],
    AgentMessage: ["agent", "Codex", item.phase ?? ""],
    Reasoning: ["reasoning", "Reasoning summary", ""],
    Extension: ["extension", "Extension", [item.kind, item.query].filter(Boolean).join(" · ")],
    ContextCompaction: ["reasoning", "Context compacted", ""],
  };
  const [kind, label, detail] = definitions[item.type] ?? ["other", itemTypeLabel(item.type), ""];
  if (item.type === "Reasoning" && !contentText(item.summary_text)) return null;
  const shell = eventShell(kind, label, detail, record.timestamp);
  if (item.type === "UserMessage" || item.type === "AgentMessage") {
    shell.body.append(element("div", "prose", contentText(item.content)));
  } else if (item.type === "Reasoning") {
    const summary = contentText(item.summary_text);
    shell.body.append(element("div", "prose", summary));
  } else if (item.type === "ContextCompaction") {
    shell.body.append(element("p", "suppressed", "Codex condensed earlier context to continue the session."));
  } else if (item.type === "Extension") {
    shell.body.append(formattedOutput(item.results ?? item.action ?? item));
  } else {
    shell.body.append(jsonNode(item));
  }
  return shell.item;
}

function renderFilterControls() {
  for (const filter of FILTERS) {
    const button = element("button", "filter");
    button.type = "button";
    button.dataset.filter = filter;
    button.setAttribute("aria-pressed", "true");
    button.append(document.createTextNode(filter));
    button.append(element("span", "count", "0"));
    button.addEventListener("click", () => {
      if (activeFilters.has(filter)) activeFilters.delete(filter);
      else activeFilters.add(filter);
      button.setAttribute("aria-pressed", String(activeFilters.has(filter)));
      applyFilters();
    });
    filtersElement.append(button);
  }
}

function applyFilters() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  for (const item of tape.children) {
    item.hidden = !activeFilters.has(item.dataset.kind) ||
      Boolean(query && !item.textContent.toLocaleLowerCase().includes(query));
  }
  updateSessionMetadata();
}

function visibleEvents() {
  return [...tape.children].filter((item) => !item.hidden);
}

function selectEvent(item, { scroll = true, block = "center" } = {}) {
  if (!item) return;
  selectedEvent?.classList.remove("is-selected");
  selectedEvent?.removeAttribute("aria-current");
  selectedEvent = item;
  selectedEvent.classList.add("is-selected");
  selectedEvent.setAttribute("aria-current", "true");
  updateSessionMetadata();
  if (scroll) {
    selectedEvent.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block,
    });
  }
}

function navigateVisibleEvents(direction) {
  const events = visibleEvents();
  if (events.length === 0) return;

  let index = events.indexOf(selectedEvent);
  if (index < 0) {
    const viewportCenter = window.innerHeight / 2;
    index = events.reduce((closestIndex, item, itemIndex) => {
      const itemRect = item.getBoundingClientRect();
      const closestRect = events[closestIndex].getBoundingClientRect();
      const itemDistance = Math.abs(itemRect.top + itemRect.height / 2 - viewportCenter);
      const closestDistance = Math.abs(closestRect.top + closestRect.height / 2 - viewportCenter);
      return itemDistance < closestDistance ? itemIndex : closestIndex;
    }, 0);
  }

  selectEvent(events[Math.max(0, Math.min(events.length - 1, index + direction))]);
  setFollow(false);
}

function updateConnectionState() {
  if (!connected) {
    connection.textContent = "Reconnecting";
    connection.className = "connection is-offline";
  } else if (follow) {
    connection.textContent = "Live";
    connection.className = "connection";
  } else {
    connection.textContent = "Paused";
    connection.className = "connection is-paused";
  }
}

function updateSessionMetadata() {
  const events = visibleEvents();
  const selectedIndex = events.indexOf(selectedEvent);
  const position = selectedIndex >= 0
    ? `${selectedIndex + 1}/${events.length}`
    : `${events.length} visible`;
  sessionName.textContent = `${position} · session ${transcriptLabel}`;
}

function sessionLabel(transcript) {
  const sessionId = String(transcript).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu,
  )?.[1];
  return sessionId ?? String(transcript).replace(/\.jsonl$/u, "");
}

function jumpToBoundary(boundary, resumeFollow) {
  const events = visibleEvents();
  if (events.length === 0) return;
  const newest = boundary === "newest";
  selectEvent(newest ? events.at(-1) : events[0], { scroll: false });
  setFollow(resumeFollow);
  if (newest) {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  } else {
    selectedEvent.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }
}

function appendRecord(record) {
  const item = renderRecord(record);
  if (!item) return;
  emptyState.hidden = true;
  tape.append(item);
  const count = (filterCounts.get(item.dataset.kind) ?? 0) + 1;
  filterCounts.set(item.dataset.kind, count);
  filtersElement.querySelector(`[data-filter="${item.dataset.kind}"] .count`).textContent = String(count);
  applyFilters();
  if (follow) {
    selectEvent(item, { scroll: false });
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }
}

function setFollow(nextFollow) {
  follow = nextFollow;
  pauseButton.setAttribute("aria-pressed", String(!follow));
  pauseButton.textContent = follow ? "Pause follow" : "Resume follow";
  updateConnectionState();
}

renderFilterControls();
searchInput.addEventListener("input", applyFilters);
pauseButton.addEventListener("click", () => setFollow(!follow));
// Selecting a card establishes the anchor for subsequent j/k navigation.
tape.addEventListener("click", (event) => {
  const item = event.target.closest(".event");
  if (!item || !tape.contains(item)) return;
  selectEvent(item, { scroll: false });
  setFollow(false);
});
jumpButton.addEventListener("click", () => jumpToBoundary("newest", true));
document.addEventListener("keydown", (event) => {
  const typingTarget = event.target.matches("input, textarea, select, [contenteditable='true']");
  if (typingTarget) return;
  if (event.key === "/" && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === "j" || event.key === "k") {
    event.preventDefault();
    navigateVisibleEvents(event.key === "j" ? 1 : -1);
  } else if (event.key === "G") {
    event.preventDefault();
    jumpToBoundary("newest", true);
  } else if (event.key === "g") {
    event.preventDefault();
    jumpToBoundary("oldest", false);
  }
});
window.addEventListener("wheel", (event) => {
  if (event.shiftKey) {
    event.preventDefault();
    const delta = event.deltaY || event.deltaX;
    const now = performance.now();
    const direction = delta > 0 ? 1 : -1;
    if (direction !== lastShiftWheelDirection) lastShiftWheelAt = 0;
    if (delta !== 0 && (lastShiftWheelAt === 0 || now - lastShiftWheelAt >= 300)) {
      lastShiftWheelAt = now;
      lastShiftWheelDirection = direction;
      navigateVisibleEvents(direction);
    }
    return;
  }
  if (event.deltaY < 0) setFollow(false);
}, { passive: false });

const source = new EventSource("/events");
source.addEventListener("record", (event) => appendRecord(JSON.parse(event.data)));
source.addEventListener("ready", (event) => {
  const value = JSON.parse(event.data);
  connected = true;
  transcriptLabel = sessionLabel(value.transcript);
  updateConnectionState();
  updateSessionMetadata();
});
source.addEventListener("warning", (event) => {
  const value = JSON.parse(event.data);
  notice.textContent = value.message;
  notice.hidden = false;
  setTimeout(() => { notice.hidden = true; }, 6_000);
});
source.onerror = () => {
  connected = false;
  updateConnectionState();
};
