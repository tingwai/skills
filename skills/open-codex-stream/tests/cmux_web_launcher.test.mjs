import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  minimapFocusMapper,
  packMinimapBars,
  minimapWindow,
  minimapViewport,
  eventIndexAtDocumentOffset,
  installMinimap,
  sampleMinimap,
} from "../../../herdr-plugins/agent-stream/web/public/minimap.js";
import {
  markdownBlocks,
  renderAgentMarkdown,
  safeLink,
  shouldRenderAgentMarkdown,
} from "../../../herdr-plugins/agent-stream/web/public/markdown-renderer.js";
import {
  followAfterScroll,
  isLongEvent,
  isTranscriptBottom,
  selectionAfterAppend,
  selectionForNavigation,
  selectionForSessionReset,
} from "../../../herdr-plugins/agent-stream/web/public/selection-state.js";

const launcher = path.resolve(import.meta.dirname, "../scripts/open_web_stream_cmux.mjs");
const autoStart = path.resolve(import.meta.dirname, "../scripts/codex_auto_start.zsh");
const webServer = path.resolve(import.meta.dirname, "../../../herdr-plugins/agent-stream/web/server.mjs");
const publicDirectory = path.resolve(import.meta.dirname, "../../../herdr-plugins/agent-stream/web/public");

function stopServer(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { /* The server already exited. */ }
}

function waitForFile(filePath, timeoutMs = 2_000) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return true;
    Atomics.wait(signal, 0, 0, 25);
  }
  return false;
}

async function readUntil(reader, expected, timeoutMs = 3_000) {
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + timeoutMs;
  while (!output.includes(expected) && Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
    ]);
    if (result.timeout || result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  return output;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function waitForHealth(url, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}health`);
      if (response.ok) return;
    } catch {
      // The server may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not become healthy at ${url}`);
}

test("browser launcher serves the shared empty state plus history and live SSE", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-stream-test-"));
  const transcriptPath = path.join(directory, "session.jsonl");
  const initialRecord = {
    type: "event_msg",
    payload: { type: "user_message", message: "initial-history-marker" },
  };
  fs.writeFileSync(transcriptPath, `${JSON.stringify(initialRecord)}\n`);
  const result = spawnSync(process.execPath, [launcher, "--transcript", transcriptPath, "--no-open"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_STREAM_WEB_STATE_DIRECTORY: directory },
  });
  assert.equal(result.status, 0, result.stderr);
  const details = JSON.parse(result.stdout);
  const controller = new AbortController();

  try {
    const page = await fetch(details.url).then((response) => response.text());
    assert.match(page, /Nothing to display yet\./u);
    assert.match(page, /id="minimap"/u);
    assert.match(page, /id="minimap-canvas"/u);
    assert.match(page, /id="toggle-minimap-debug"/u);
    assert.match(page, /id="minimap-debug-controls"[^>]*hidden/u);
    assert.match(page, /value="66\.5"[^>]*data-minimap-setting="windowViewports"/u);
    assert.doesNotMatch(page, /id="search"|search-control|command, output, path/u);
    assert.doesNotMatch(page, /id="pause"|Pause follow|Resume follow|quiet-button/u);
    assert.match(page, /role="scrollbar"/u);
    assert.match(page, /tabindex="0"/u);
    assert.doesNotMatch(page, /view-switcher|view-select|waterfall|Theme test|theme-select|Terminal Ledger|Signal Index|Baseline/u);
    assert.equal((await fetch(`${details.url}ide-rail.css`)).status, 200);
    assert.equal((await fetch(`${details.url}minimap.js`)).status, 200);
    assert.equal((await fetch(`${details.url}markdown-renderer.js`)).status, 200);
    assert.equal((await fetch(`${details.url}selection-state.js`)).status, 200);
    assert.equal((await fetch(`${details.url}markdown.css`)).status, 200);
    for (const removedAsset of [
      "theme-switcher.js",
      "theme-switcher.css",
      "baseline-compact.css",
      "themes/terminal-ledger.css",
      "themes/signal-index.css",
      "views.css",
      "view-controller.js",
    ]) {
      assert.equal((await fetch(`${details.url}${removedAsset}`)).status, 404);
    }
    const health = await fetch(`${details.url}health`).then((response) => response.json());
    assert.equal(health.status, "ok");
    assert.equal(health.retainedEvents, 1);

    const response = await fetch(`${details.url}events`, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.match(await readUntil(reader, "initial-history-marker"), /initial-history-marker/u);

    const liveRecord = {
      type: "event_msg",
      payload: { type: "agent_message", message: "live-event-marker" },
    };
    fs.appendFileSync(transcriptPath, `${JSON.stringify(liveRecord)}\n`);
    assert.match(await readUntil(reader, "live-event-marker"), /live-event-marker/u);
  } finally {
    controller.abort();
    stopServer(details.serverPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser navigation resumes follow at newest and preserves pause above it", () => {
  const older = selectionForNavigation(3, 2, -1);
  assert.deepEqual(older, { selectedIndex: 1, following: false });
  assert.deepEqual(selectionAfterAppend(4, older.selectedIndex, older.following), {
    selectedIndex: 1,
    following: false,
  });

  const newest = selectionForNavigation(3, older.selectedIndex, 1);
  assert.deepEqual(newest, { selectedIndex: 2, following: true });
  assert.deepEqual(selectionAfterAppend(4, newest.selectedIndex, newest.following), {
    selectedIndex: 3,
    following: true,
  });

  assert.deepEqual(selectionForNavigation(0, -1, -1), { selectedIndex: -1, following: true });
  assert.deepEqual(selectionForNavigation(1, 0, -1), { selectedIndex: 0, following: true });
  assert.deepEqual(selectionForNavigation(1, 0, 1), { selectedIndex: 0, following: true });

  const resumed = selectionForSessionReset();
  assert.deepEqual(resumed, { selectedIndex: -1, following: true });
  assert.deepEqual(selectionAfterAppend(1, resumed.selectedIndex, resumed.following), {
    selectedIndex: 0,
    following: true,
  });
});

test("true transcript bottom resumes live across every scroll path without tall-output false positives", () => {
  assert.equal(isTranscriptBottom(1_499, 500, 2_000), true);
  assert.equal(isTranscriptBottom(1_498.25, 500, 2_000), true,
    "Subpixel layout within the two-pixel tolerance is bottom");
  assert.equal(isTranscriptBottom(1_497.9, 500, 2_000), false);

  const atBottom = {
    following: false,
    previousScrollY: 1_200,
    scrollY: 1_499,
    viewportHeight: 500,
    documentHeight: 2_000,
  };
  assert.equal(followAfterScroll(atBottom), true,
    "Wheel, touch, keyboard, or minimap scroll all resume from the same bottom geometry");
  assert.equal(followAfterScroll({
    ...atBottom,
    following: true,
    previousScrollY: 1_500,
    scrollY: 1_490,
  }), false, "Scrolling upward exits live immediately");
  assert.equal(followAfterScroll({
    following: false,
    previousScrollY: 850,
    scrollY: 900,
    viewportHeight: 500,
    documentHeight: 2_000,
  }), false, "Being inside the newest tall output but materially above bottom remains history");

  const resumed = selectionAfterAppend(4, 2, followAfterScroll(atBottom));
  assert.deepEqual(resumed, { selectedIndex: 3, following: true },
    "A live append advances the synchronized newest selection");
  const paused = selectionAfterAppend(4, 2, false);
  assert.deepEqual(paused, { selectedIndex: 2, following: false });
});

test("sticky event context is reserved for messages taller than the usable viewport", () => {
  assert.equal(isLongEvent(701, 800, 100), true);
  assert.equal(isLongEvent(700, 800, 100), false);
  assert.equal(isLongEvent(1_400, 800, 100), true);
  assert.equal(isLongEvent(100, 0, 100), false);
});

test("assistant Markdown parsing is safe, scoped, and preserves plain text fallback", () => {
  class FakeNode {
    constructor(type, value = "") {
      this.type = type;
      this.value = value;
      this.children = [];
      this.dataset = {};
    }
    append(...children) { this.children.push(...children); }
    set textContent(value) { this.children = [new FakeNode("#text", String(value))]; }
  }
  const fakeDocument = {
    createElement: (tagName) => new FakeNode(tagName),
    createTextNode: (value) => new FakeNode("#text", value),
  };
  const inline = markdownBlocks("Use `rg --files` before editing.");
  assert.equal(inline[0].type, "paragraph");
  assert.deepEqual(inline[0].lines[0].map((node) => node.type), ["text", "code", "text"]);
  assert.equal(inline[0].lines[0][1].value, "rg --files");

  const fenced = markdownBlocks("```js\nconst safe = true;\n```");
  assert.deepEqual(fenced, [{
    type: "codeBlock",
    language: "js",
    value: "const safe = true;",
  }]);

  const structured = markdownBlocks("## Result\n\n- **one**\n- [docs](https://example.com/path)\n- [bad](javascript:alert(1))");
  assert.equal(structured[0].type, "heading");
  assert.equal(structured[1].type, "list");
  assert.equal(structured[1].items.length, 3);
  assert.equal(structured[1].items[1][0].type, "link");
  assert.equal(safeLink("https://example.com/path"), "https://example.com/path");
  assert.equal(safeLink("mailto:test@example.com"), "mailto:test@example.com");
  assert.equal(safeLink("javascript:alert(1)"), null);
  assert.equal(safeLink("data:text/html,<script>alert(1)</script>"), null);

  const rawHtml = markdownBlocks("**Safe** <img src=x onerror=alert(1)><script>alert(2)</script>");
  assert.doesNotMatch(JSON.stringify(rawHtml), /"type":"(?:html|raw)"/u);
  assert.match(JSON.stringify(rawHtml), /<img src=x/u, "raw HTML must remain inert text content");
  assert.equal(markdownBlocks("Ordinary assistant text with no Markdown syntax."), null);

  const rendered = renderAgentMarkdown(
    fakeDocument,
    { type: "AgentMessage", phase: "final_answer" },
    "**Safe** <script>alert(1)</script> [bad](javascript:alert(2)) and `code`",
  );
  const renderedNodes = [];
  const visit = (node) => {
    renderedNodes.push(node);
    for (const child of node.children) visit(child);
  };
  visit(rendered);
  assert.doesNotMatch(renderedNodes.map((node) => node.type).join(" "), /script|img/u);
  assert.equal(renderedNodes.some((node) => node.type === "a"), false, "unsafe links stay inert text");
  assert.equal(renderedNodes.some((node) => node.type === "code"), true);
  assert.match(renderedNodes.filter((node) => node.type === "#text").map((node) => node.value).join(""), /<script>/u);

  assert.equal(shouldRenderAgentMarkdown({ type: "AgentMessage", phase: "commentary" }), true);
  assert.equal(shouldRenderAgentMarkdown({ type: "AgentMessage", phase: "final_answer" }), true);
  assert.equal(shouldRenderAgentMarkdown({ type: "AgentMessage", phase: null }), false);
  assert.equal(shouldRenderAgentMarkdown({ type: "CommandExecution", phase: "final_answer" }), false);
  assert.equal(shouldRenderAgentMarkdown({ type: "Reasoning", phase: "commentary" }), false);
});

test("IDE Activity Rail is the sole compact skin in narrow panes", () => {
  const ideCss = fs.readFileSync(path.join(publicDirectory, "ide-rail.css"), "utf8");
  const markdownCss = fs.readFileSync(path.join(publicDirectory, "markdown.css"), "utf8");
  assert.match(ideCss, /IDE Activity Rail — the sole browser stream skin/u);
  assert.doesNotMatch(ideCss, /\bzoom\s*:/u);
  assert.match(ideCss, /\.event-header \{\s*min-height: 26px;/u);
  assert.match(ideCss, /\.event\.is-long > \.event-header \{\s*position: sticky;/u);
  assert.match(ideCss, /top: var\(--event-sticky-top\);/u);
  assert.match(ideCss, /\.event-body \{ padding: 4\.5px 9px 9px; \}/u);
  assert.match(ideCss, /main \{ width: 100%; margin: 0; padding: 11px 11px 0; \}/u);
  assert.match(ideCss, /\.transcript-column \{ min-width: 0; padding-bottom: 42vh; \}/u);
  assert.match(ideCss, /border-radius: 2px/u);
  assert.match(ideCss, /@media \(max-width: 420px\)/u);
  assert.match(ideCss, /grid-template-columns: minmax\(0, 1fr\) 16px/u);
  assert.match(ideCss, /\.minimap canvas \{\s*width: 14\.4px;/u);
  assert.match(ideCss, /grid-template-columns: minmax\(0, 1fr\) 14\.4px/u);
  assert.match(ideCss, /\.minimap-viewport[^{]*\{[^}]*box-sizing: border-box;[^}]*border: 2px solid #fff;/u);
  assert.match(ideCss, /scrollbar-width: none/u);
  assert.match(ideCss, /html::-webkit-scrollbar/u);
  for (const filter of ["user", "agent", "command", "reasoning", "change", "extension"]) {
    assert.match(ideCss, new RegExp(`\\.filter\\[data-filter="${filter}"\\]`, "u"));
  }
  assert.match(ideCss, /box-shadow: inset 0 -2px var\(--filter-color\)/u);
  assert.match(ideCss, /\.filter\[aria-pressed="false"\][^{]*\{[^}]*opacity: \.58/u);
  assert.match(markdownCss, /\.markdown-inline-code/u);
  assert.match(markdownCss, /font: \.9em\/1\.35 var\(--utility-font\)/u);
  assert.match(markdownCss, /\.markdown \.markdown-code-block/u);
  assert.equal(fs.existsSync(path.resolve(publicDirectory, "../theme-proposals")), false);
});

test("minimap sampling stays bounded and maps click or drag to transcript selection", () => {
  const events = Array.from({ length: 10_000 }, (_, index) => ({
    kind: ["user", "agent", "command", "status"][index % 4],
    contentLength: index % 97,
  }));
  const bins = sampleMinimap(events, 180);
  assert.equal(bins.length, 180, "Long sessions must not create one overview node per event or pixel");
  assert.deepEqual(sampleMinimap(events, 180), bins, "Bounded aggregation must be deterministic");
  assert.equal(bins[0].startIndex, 0);
  assert.equal(bins.at(-1).endIndex, 9_999);
  assert.deepEqual(minimapViewport(1_500, 500, 2_000), {
    topRatio: .75,
    heightRatio: .25,
  });
  const partialViewport = minimapViewport(250, 500, 1_500);
  assert.ok(Math.abs(partialViewport.topRatio - 1 / 6) < 1e-12);
  assert.equal(partialViewport.heightRatio, 1 / 3);

  const topWindow = minimapWindow(0, 500, 10_000);
  const middleWindow = minimapWindow(4_750, 500, 10_000);
  const bottomWindow = minimapWindow(9_500, 500, 10_000);
  assert.deepEqual(topWindow, {
    start: 0, end: 4_000, span: 4_000, topRatio: 0, heightRatio: .125,
  });
  assert.deepEqual(middleWindow, {
    start: 3_000, end: 7_000, span: 4_000, topRatio: .4375, heightRatio: .125,
  });
  assert.deepEqual(bottomWindow, {
    start: 6_000, end: 10_000, span: 4_000, topRatio: .875, heightRatio: .125,
  });
  assert.ok(minimapWindow(2_000, 500, 10_000, 8, 1).start >
    minimapWindow(2_000, 500, 10_000, 8, 0).start);

  const focus = minimapFocusMapper(.5, .125, 4, 1.25);
  assert.ok(focus.forward(.5625) - focus.forward(.4375) > .125,
    "Focus zoom magnifies the current viewport portion of the minimap");
  for (const ratio of [0, .1, .5, .9, 1]) {
    assert.ok(Math.abs(focus.inverse(focus.forward(ratio)) - ratio) < 1e-6);
  }
  const newestIndex = events.length - 1;
  assert.equal(selectionForNavigation(events.length, newestIndex - 1, 1).following, true);
  assert.equal(selectionForNavigation(events.length, newestIndex, -1).following, false);
});

test("minimap aggregation retains event count and dominant kind", () => {
  const aggregate = sampleMinimap([
    { kind: "agent" },
    { kind: "command" },
    { kind: "agent" },
  ], 1);
  assert.equal(aggregate[0].count, 3);
  assert.equal(aggregate[0].kind, "agent");
});

test("minimap bar packing enforces four-pixel marks without overlap", () => {
  const packed = packMinimapBars([
    { kind: "user", top: 0, height: 1 },
    { kind: "agent", top: 1, height: 1 },
    { kind: "command", top: 2, height: 80 },
    { kind: "change", top: 79, height: 1 },
  ], 80, 4);
  assert.ok(packed.every((bar) => bar.height >= 4));
  assert.ok(packed.every((bar) => bar.top >= 0 && bar.top + bar.height <= 80 + 1e-9));
  for (let index = 1; index < packed.length; index += 1) {
    assert.ok(packed[index].top >= packed[index - 1].top + packed[index - 1].height - 1e-9,
      "Packed minimap bars must not overlap");
  }
});

test("minimap preserves measured geometry and exact partial-message position", () => {
  const geometry = [
    { kind: "user", contentLength: 20, top: 100, height: 180 },
    { kind: "command", contentLength: 2_000, top: 280, height: 1_400 },
    { kind: "agent", contentLength: 200, top: 1_680, height: 220 },
  ];
  const bins = sampleMinimap(geometry);
  assert.deepEqual(bins.map(({ top, bottom }) => ({ top, bottom })), [
    { top: 100, bottom: 280 },
    { top: 280, bottom: 1_680 },
    { top: 1_680, bottom: 1_900 },
  ]);
  assert.equal(
    eventIndexAtDocumentOffset(geometry, 1_000),
    1,
    "Halfway scroll remains within the tall command instead of snapping to an event boundary",
  );
  assert.equal(eventIndexAtDocumentOffset(geometry, 1_750), 2);

  const longGeometry = Array.from({ length: 10_000 }, (_, index) => ({
    kind: index % 2 ? "agent" : "command",
    contentLength: index * 3,
    top: index * 20,
    height: index % 7 === 0 ? 1_000 : 20,
    scrollTop: index * 20,
  }));
  const longBins = sampleMinimap(longGeometry, 180);
  assert.equal(longBins.length, 180);
  assert.equal(longBins[0].top, 0);
  assert.ok(longBins.every((bin) => bin.bottom >= bin.top));
  assert.deepEqual(sampleMinimap(longGeometry, 180), longBins,
    "Resize redraws reuse deterministic bounded geometry");
});

test("minimap maps tall-output navigation and pins the viewport at true bottom", () => {
  const listeners = new Map();
  let fillCount = 0;
  const fillRects = [];
  const context = {
    setTransform() {}, clearRect() {}, fillRect(...rect) { fillCount += 1; fillRects.push(rect); },
    set fillStyle(value) {}, set globalAlpha(value) {},
  };
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    attributes: new Map(),
    getBoundingClientRect: () => ({ top: 0, width: 16, height: 320 }),
    getContext: () => context,
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) { listeners.set(`canvas:${name}`, listener); },
    setPointerCapture() {},
  };
  const viewport = { style: {} };
  const tape = {};
  const events = [
    { dataset: { kind: "user", contentLength: "20" }, getBoundingClientRect: () => ({ top: -200, height: 120 }) },
    { dataset: { kind: "command", contentLength: "200" }, getBoundingClientRect: () => ({ top: -80, height: 120 }) },
    { dataset: { kind: "agent", contentLength: "2000" }, getBoundingClientRect: () => ({ top: 40, height: 1_760 }) },
  ];
  const documentValue = {
    documentElement: { scrollHeight: 2_000 },
    querySelector(selector) {
      return { "#minimap-canvas": canvas, "#minimap-viewport": viewport, "#tape": tape }[selector] ?? null;
    },
    addEventListener(name, listener) { listeners.set(`document:${name}`, listener); },
  };
  const windowValue = {
    innerHeight: 500,
    scrollY: 200,
    devicePixelRatio: 2,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame(callback) { callback(); },
    addEventListener(name, listener) { listeners.set(`window:${name}`, listener); },
    ResizeObserver: class { observe() {} },
  };
  const navigations = [];
  installMinimap({
    documentValue,
    windowValue,
    getEvents: () => events,
    navigate(value) { navigations.push(value); },
  });
  assert.ok(fillRects.every(([, , width]) => width === 14),
    "Every minimap event uses the full available rail width");
  assert.ok(fillRects.every(([, , , height]) => height >= 4),
    "Every minimap event remains at least four pixels tall");
  for (let index = 1; index < fillRects.length; index += 1) {
    const previousBottom = fillRects[index - 1][1] + fillRects[index - 1][3];
    assert.ok(fillRects[index][1] >= previousBottom - 1e-9,
      "Rendered minimap events must not overlap");
  }
  listeners.get("canvas:pointerdown")({ clientY: 160, pointerId: 1 });
  assert.equal(navigations.at(-1).following, false,
    "The minimap must not resume live in the middle of a tall newest output");
  listeners.get("canvas:pointerdown")({ clientY: 320, pointerId: 1 });
  assert.equal(navigations.at(-1).following, true,
    "The minimap must resume live at the true transcript bottom");
  const initialFillCount = fillCount;
  windowValue.scrollY = 1_500;
  assert.doesNotThrow(() => listeners.get("window:scroll")());
  const viewportTop = Number.parseFloat(viewport.style.top);
  const viewportHeight = Number.parseFloat(viewport.style.height);
  assert.ok(viewportHeight > 25, "Focus zoom magnifies the viewport indicator");
  assert.ok(Math.abs(viewportTop + viewportHeight - 100) < 1e-9,
    "The magnified viewport indicator stays flush at true bottom");
  assert.equal(fillCount, initialFillCount, "Scrolling moves only the viewport indicator, not minimap geometry");
});

test("manual launcher immediately attaches an existing exact-surface session with inactive registry flags", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-manual-existing-test-"));
  const exactTranscript = path.join(directory, "exact.jsonl");
  const staleTranscript = path.join(directory, "stale.jsonl");
  const otherTranscript = path.join(directory, "other.jsonl");
  const sessionStatePath = path.join(directory, "sessions.json");
  const cmuxEventsPath = path.join(directory, "events.jsonl");
  const fakeCmux = path.join(directory, "cmux");
  fs.writeFileSync(exactTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "existing-exact-history-marker" },
  })}\n`);
  fs.writeFileSync(staleTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "stale-same-surface-marker" },
  })}\n`);
  fs.writeFileSync(otherTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "cross-surface-marker" },
  })}\n`);
  fs.writeFileSync(sessionStatePath, JSON.stringify({ sessions: [
    {
      surface_id: "source-existing",
      active_for_surface: false,
      active_surface_session_id: null,
      session_id: "session-stale",
      started_at: "2026-08-27T01:00:00.000Z",
      updated_at_unix: 999,
      codex_transcript_path: staleTranscript,
    },
    {
      surface_id: "source-existing",
      active_for_surface: false,
      active_surface_session_id: null,
      session_id: "session-exact",
      started_at: "2026-08-27T02:00:00.000Z",
      updated_at_unix: 100,
      codex_transcript_path: exactTranscript,
    },
    {
      surface_id: "other-source",
      active_for_surface: true,
      session_id: "session-other",
      codex_transcript_path: otherTranscript,
    },
  ] }));
  fs.writeFileSync(cmuxEventsPath, [
    JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "other-source",
      payload: { session_id: "codex-session-other" },
    }),
    JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "source-existing",
      payload: { session_id: "codex-session-exact" },
    }),
  ].join("\n") + "\n");
  fs.writeFileSync(fakeCmux, `#!/usr/bin/env node
const fs = require("node:fs");
process.stdout.write(fs.readFileSync(process.env.CMUX_TEST_SESSION_STATE, "utf8") + "\\n");
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [launcher, "--no-open"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CMUX_BIN_PATH: fakeCmux,
      CMUX_SURFACE_ID: "source-existing",
      CMUX_WORKSPACE_ID: "workspace-existing",
      CMUX_EVENTS_PATH: cmuxEventsPath,
      CMUX_TEST_SESSION_STATE: sessionStatePath,
      AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const details = JSON.parse(result.stdout);
  const controller = new AbortController();
  try {
    assert.equal(details.sessionId, "session-exact");
    assert.equal(details.transcriptPath, exactTranscript);
    await waitForHealth(details.url);
    const response = await fetch(`${details.url}events`, { signal: controller.signal });
    const history = await readUntil(response.body.getReader(), "existing-exact-history-marker");
    assert.match(history, /existing-exact-history-marker/u);
    assert.doesNotMatch(history, /stale-same-surface-marker|cross-surface-marker/u);
  } finally {
    controller.abort();
    stopServer(details.serverPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("empty server attaches only to later authoritative metadata for its source surface", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-first-attach-test-"));
  const exactTranscript = path.join(directory, "exact.jsonl");
  const otherTranscript = path.join(directory, "other.jsonl");
  const sessionStatePath = path.join(directory, "sessions.json");
  const cmuxEventsPath = path.join(directory, "events.jsonl");
  const fakeCmux = path.join(directory, "cmux");
  const port = await availablePort();
  fs.writeFileSync(exactTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "exact-first-session-marker" },
  })}\n`);
  fs.writeFileSync(otherTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "cross-surface-marker" },
  })}\n`);
  fs.writeFileSync(cmuxEventsPath, "");
  fs.writeFileSync(sessionStatePath, JSON.stringify({ sessions: [{
    surface_id: "other-source",
    active_for_surface: true,
    session_id: "session-other",
    codex_transcript_path: otherTranscript,
  }] }));
  fs.writeFileSync(fakeCmux, `#!/usr/bin/env node
const fs = require("node:fs");
process.stdout.write(fs.readFileSync(process.env.CMUX_TEST_SESSION_STATE, "utf8") + "\\n");
`, { mode: 0o755 });
  const server = spawn(process.execPath, [
    webServer,
    "--port", String(port),
    "--cmux-surface", "source-first",
    "--cmux-bin", fakeCmux,
    "--cmux-events", cmuxEventsPath,
    "--session-poll-ms", "50",
  ], {
    stdio: "ignore",
    env: { ...process.env, CMUX_TEST_SESSION_STATE: sessionStatePath },
  });
  const controller = new AbortController();
  try {
    const url = `http://127.0.0.1:${port}/`;
    await waitForHealth(url);
    const response = await fetch(`${url}events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const initial = await readUntil(reader, "event: ready");
    assert.match(initial, /"sessionId":null/u);
    assert.doesNotMatch(initial, /cross-surface-marker/u);

    fs.writeFileSync(sessionStatePath, JSON.stringify({ sessions: [
      {
        surface_id: "other-source",
        active_for_surface: true,
        session_id: "session-other",
        codex_transcript_path: otherTranscript,
      },
      {
        surface_id: "source-first",
        active_for_surface: true,
        session_id: "session-exact",
        codex_transcript_path: exactTranscript,
      },
    ] }));
    const attached = await readUntil(reader, "exact-first-session-marker");
    assert.match(attached, /event: session/u);
    assert.match(attached, /session-exact/u);
    assert.doesNotMatch(attached, /cross-surface-marker/u);
  } finally {
    controller.abort();
    try { server.kill("SIGTERM"); } catch { /* The test server already exited. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-opened browser server attaches first session then follows exact-surface resume", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-session-switch-test-"));
  const firstTranscript = path.join(directory, "first.jsonl");
  const resumedTranscript = path.join(directory, "resumed.jsonl");
  const cmuxEventsPath = path.join(directory, "events.jsonl");
  const hookResolveCountPath = path.join(directory, "hook-resolve-count");
  const fakeCmux = path.join(directory, "cmux");
  const port = await availablePort();
  const firstRecords = [
    { type: "event_msg", payload: { type: "user_message", message: "old-history-marker" } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "Reasoning", summary_text: "safe-summary-marker", private_reasoning: "private-marker" },
      },
    },
  ];
  fs.writeFileSync(firstTranscript, `${firstRecords.map(JSON.stringify).join("\n")}\n`);
  fs.writeFileSync(resumedTranscript, `${JSON.stringify({
    type: "event_msg",
    payload: {
      type: "agent_message",
      phase: "final_answer",
      message: "resumed-history-marker with `inline-code-marker`",
    },
  })}\n`);
  fs.writeFileSync(cmuxEventsPath, "");
  fs.writeFileSync(fakeCmux, `#!/usr/bin/env node
const fs = require("node:fs");
const resolvingHook = process.argv.includes("--session");
if (resolvingHook) {
  const count = fs.existsSync(process.env.CMUX_TEST_HOOK_COUNT)
    ? Number(fs.readFileSync(process.env.CMUX_TEST_HOOK_COUNT, "utf8")) + 1
    : 1;
  fs.writeFileSync(process.env.CMUX_TEST_HOOK_COUNT, String(count));
  if (count === 1) {
    process.stdout.write('{"sessions":[]}\\n');
    process.exit(0);
  }
}
process.stdout.write(JSON.stringify({ sessions: [
  {
    surface_id: "source-switch",
    active_for_surface: false,
    active_surface_session_id: null,
    runtime_status: "idle",
    session_id: "session-first",
    codex_transcript_path: ${JSON.stringify(firstTranscript)},
  },
  {
    surface_id: "source-switch",
    active_for_surface: false,
    active_surface_session_id: null,
    runtime_status: "idle",
    session_id: "session-resumed",
    codex_transcript_path: ${JSON.stringify(resumedTranscript)},
  },
] }) + "\\n");
`, { mode: 0o755 });
  const server = spawn(process.execPath, [
    webServer,
    "--port", String(port),
    "--cmux-surface", "source-switch",
    "--cmux-bin", fakeCmux,
    "--cmux-events", cmuxEventsPath,
    "--session-poll-ms", "50",
  ], {
    stdio: "ignore",
    env: { ...process.env, CMUX_TEST_HOOK_COUNT: hookResolveCountPath },
  });
  const controller = new AbortController();
  try {
    const url = `http://127.0.0.1:${port}/`;
    await waitForHealth(url);
    const response = await fetch(`${url}events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const initial = await readUntil(reader, "event: ready");
    assert.match(initial, /"sessionId":null/u);
    assert.match(initial, /"transcript":null/u);
    assert.doesNotMatch(initial, /old-history-marker|resumed-history-marker/u);

    fs.appendFileSync(cmuxEventsPath, `${JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "different-source",
      payload: { session_id: "codex-session-first" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert.equal((await fetch(`${url}health`).then((health) => health.json())).sessionId, null);

    fs.appendFileSync(cmuxEventsPath, `${JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "source-switch",
      payload: { session_id: "codex-session-first" },
    })}\n`);
    const attached = await readUntil(reader, "safe-summary-marker");
    assert.match(attached, /event: session/u);
    assert.match(attached, /session-first/u);
    assert.match(attached, /old-history-marker/u);
    assert.match(attached, /safe-summary-marker/u);
    assert.doesNotMatch(attached, /private-marker|resumed-history-marker/u);
    assert.ok(Number(fs.readFileSync(hookResolveCountPath, "utf8")) >= 2,
      "The hook signal was not retried while Cmux finished persisting the first registry row");

    fs.appendFileSync(cmuxEventsPath, `${JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "different-source",
      payload: { session_id: "codex-session-resumed" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 125));
    assert.equal((await fetch(`${url}health`).then((health) => health.json())).sessionId, "session-first");

    fs.appendFileSync(cmuxEventsPath, `${JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "source-switch",
      payload: { session_id: "codex-session-resumed" },
    })}\n`);
    const switched = await readUntil(reader, "resumed-history-marker");
    assert.match(switched, /event: session/u);
    assert.match(switched, /session-resumed/u);
    assert.match(switched, /final_answer/u);
    assert.match(switched, /inline-code-marker/u);
    assert.ok(switched.indexOf("event: session") < switched.indexOf("resumed-history-marker"));
    assert.doesNotMatch(switched, /old-history-marker/u);

    fs.appendFileSync(firstTranscript, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "old-leak-marker" },
    })}\n`);
    fs.appendFileSync(resumedTranscript, `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "commentary",
        message: "resumed-live-marker\n- live-list-marker",
      },
    })}\n`);
    const live = await readUntil(reader, "resumed-live-marker");
    assert.match(live, /resumed-live-marker/u);
    assert.match(live, /live-list-marker/u);
    assert.match(live, /commentary/u);
    assert.doesNotMatch(live, /old-leak-marker/u);
  } finally {
    controller.abort();
    try { server.kill("SIGTERM"); } catch { /* The test server already exited. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser launcher creates an unfocused native pane to the right", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-pane-test-"));
  const transcriptPath = path.join(directory, "session.jsonl");
  const logPath = path.join(directory, "cmux.log");
  const fakeCmux = path.join(directory, "cmux");
  fs.writeFileSync(transcriptPath, "");
  fs.writeFileSync(fakeCmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$CMUX_TEST_LOG"
case "$1" in
  browser) printf '%s\\n' 'http://127.0.0.1:4319/' ;;
  --json) printf '%s\\n' '{"surface_id":"browser-test"}' ;;
esac
`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [launcher, "--transcript", transcriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CMUX_BIN_PATH: fakeCmux,
      CMUX_SURFACE_ID: "source-test",
      CMUX_WORKSPACE_ID: "workspace-test",
      CMUX_TEST_LOG: logPath,
      AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const details = JSON.parse(result.stdout);
  try {
    const command = fs.readFileSync(logPath, "utf8");
    assert.match(command, /new-pane --type browser --direction right/u);
    assert.match(command, /--workspace workspace-test/u);
    assert.match(command, /--focus false/u);
    assert.match(command, new RegExp(`--url ${details.url.replaceAll("/", "\\/")}`, "u"));
    const processCommand = spawnSync("/bin/ps", ["-p", String(details.serverPid), "-o", "command="], {
      encoding: "utf8",
    }).stdout;
    assert.match(processCommand, /--exit-idle 30/u);
    assert.match(processCommand, /agent-stream\/web\/server\.mjs/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "source-test.json"), "utf8")).serverPid,
      details.serverPid);

    const duplicate = spawnSync(process.execPath, [launcher, "--transcript", transcriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        CMUX_BIN_PATH: fakeCmux,
        CMUX_SURFACE_ID: "source-test",
        CMUX_WORKSPACE_ID: "workspace-test",
        CMUX_TEST_LOG: logPath,
        AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
      },
    });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).status, "already_open");
    const updatedCommand = fs.readFileSync(logPath, "utf8");
    assert.equal((updatedCommand.match(/new-pane --type browser/gu) ?? []).length, 1);
  } finally {
    stopServer(details.serverPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser launcher refuses to start an orphan server outside a Cmux workspace", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-workspace-test-"));
  const transcriptPath = path.join(directory, "session.jsonl");
  fs.writeFileSync(transcriptPath, "");
  const result = spawnSync(process.execPath, [launcher, "--transcript", transcriptPath], {
    encoding: "utf8",
    env: { ...process.env, CMUX_WORKSPACE_ID: "" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run this viewer from a Cmux terminal/u);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("browser launcher stops its empty server when Cmux rejects pane creation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-failure-test-"));
  const fakeCmux = path.join(directory, "cmux");
  const port = await availablePort();
  fs.writeFileSync(fakeCmux, `#!/bin/sh
printf '%s\\n' 'socket permission denied' >&2
exit 1
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [
    launcher, "--auto", "--port", String(port),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CMUX_BIN_PATH: fakeCmux,
      CMUX_SURFACE_ID: "source-failure",
      CMUX_WORKSPACE_ID: "workspace-failure",
      AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /socket permission denied/u);
  let released = false;
  for (let attempt = 0; attempt < 20 && !released; attempt += 1) {
    released = await canBind(port);
    if (!released) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(released, true, "The failed launch left its transcript server running");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("automatic browser launch immediately opens and deduplicates without a registered session", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-auto-test-"));
  const logPath = path.join(directory, "cmux.log");
  const fakeCmux = path.join(directory, "cmux");
  fs.writeFileSync(fakeCmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$CMUX_TEST_LOG"
if [ "$1" = sessions ]; then
  printf '%s\\n' '{"sessions":[]}'
elif [ "$1" = --json ]; then
  printf '%s\\n' '{"surface_id":"browser-auto"}'
elif [ "$1" = browser ]; then
  printf '%s\\n' 'http://127.0.0.1:4319/'
fi
`, { mode: 0o755 });

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [launcher, "--auto"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CMUX_BIN_PATH: fakeCmux,
      CMUX_SURFACE_ID: "source-auto",
      CMUX_WORKSPACE_ID: "workspace-auto",
      CMUX_TEST_LOG: logPath,
      AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const details = JSON.parse(result.stdout);
  try {
    assert.ok(Date.now() - startedAt < 2_000, "Automatic launch waited for session registration");
    assert.equal(details.sessionId, null);
    assert.equal(details.transcriptPath, null);
    assert.equal(details.viewerSurfaceId, "browser-auto");
    const health = await fetch(`${details.url}health`).then((response) => response.json());
    assert.equal(health.sessionId, null);
    assert.equal(health.transcript, null);
    assert.equal(health.retainedEvents, 0);
    assert.match(await fetch(details.url).then((response) => response.text()), /Nothing to display yet\./u);
    const processCommand = spawnSync("/bin/ps", ["-p", String(details.serverPid), "-o", "command="], {
      encoding: "utf8",
    }).stdout;
    assert.doesNotMatch(processCommand, /--transcript/u);

    const duplicate = spawnSync(process.execPath, [launcher, "--auto"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CMUX_BIN_PATH: fakeCmux,
        CMUX_SURFACE_ID: "source-auto",
        CMUX_WORKSPACE_ID: "workspace-auto",
        CMUX_TEST_LOG: logPath,
        AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
      },
    });
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).status, "already_open");
    assert.equal((fs.readFileSync(logPath, "utf8").match(/new-pane --type browser/gu) ?? []).length, 1);
  } finally {
    stopServer(details.serverPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual invocation upgrades an existing empty pane to the current conversation without a new prompt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-upgrade-test-"));
  const transcriptPath = path.join(directory, "existing.jsonl");
  const sessionsPath = path.join(directory, "sessions.json");
  const eventsPath = path.join(directory, "events.jsonl");
  const logPath = path.join(directory, "cmux.log");
  const fakeCmux = path.join(directory, "cmux");
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", message: "manual-upgrade-history-marker" },
  })}\n`);
  fs.writeFileSync(sessionsPath, JSON.stringify({ sessions: [] }));
  fs.writeFileSync(eventsPath, "");
  fs.writeFileSync(fakeCmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$CMUX_TEST_LOG"
if [ "$1" = sessions ]; then
  cat "$CMUX_TEST_SESSIONS"
elif [ "$1" = --json ]; then
  printf '%s\\n' '{"surface_id":"browser-upgrade"}'
elif [ "$1" = browser ]; then
  printf '%s\\n' 'http://127.0.0.1:4319/'
fi
`, { mode: 0o755 });
  const environment = {
    ...process.env,
    CMUX_BIN_PATH: fakeCmux,
    CMUX_SURFACE_ID: "source-upgrade",
    CMUX_WORKSPACE_ID: "workspace-upgrade",
    CMUX_EVENTS_PATH: eventsPath,
    CMUX_TEST_LOG: logPath,
    CMUX_TEST_SESSIONS: sessionsPath,
    AGENT_STREAM_WEB_STATE_DIRECTORY: directory,
  };
  const automatic = spawnSync(process.execPath, [launcher, "--auto"], { encoding: "utf8", env: environment });
  assert.equal(automatic.status, 0, automatic.stderr);
  const emptyDetails = JSON.parse(automatic.stdout);
  try {
    assert.equal(emptyDetails.transcriptPath, null);
    fs.writeFileSync(sessionsPath, JSON.stringify({ sessions: [{
      surface_id: "source-upgrade",
      active_for_surface: false,
      active_surface_session_id: null,
      session_id: "session-upgrade",
      started_at: "2026-08-27T02:00:00.000Z",
      codex_transcript_path: transcriptPath,
    }] }));
    fs.writeFileSync(eventsPath, `${JSON.stringify({
      name: "agent.hook.UserPromptSubmit",
      surface_id: "source-upgrade",
      payload: { session_id: "codex-session-upgrade" },
    })}\n`);

    const manual = spawnSync(process.execPath, [launcher], { encoding: "utf8", env: environment });
    assert.equal(manual.status, 0, manual.stderr);
    const attached = JSON.parse(manual.stdout);
    assert.equal(attached.status, "restored");
    assert.equal(attached.viewerSurfaceId, emptyDetails.viewerSurfaceId);
    assert.notEqual(attached.serverPid, emptyDetails.serverPid);
    assert.equal(attached.sessionId, "session-upgrade");
    assert.equal(attached.transcriptPath, transcriptPath);
    await waitForHealth(attached.url);
    const controller = new AbortController();
    const response = await fetch(`${attached.url}events`, { signal: controller.signal });
    const history = await readUntil(response.body.getReader(), "manual-upgrade-history-marker");
    controller.abort();
    assert.match(history, /manual-upgrade-history-marker/u);
    const commands = fs.readFileSync(logPath, "utf8");
    assert.equal((commands.match(/new-pane --type browser/gu) ?? []).length, 1);
    assert.match(commands, /browser --surface browser-upgrade navigate/u);
    stopServer(attached.serverPid);
  } finally {
    stopServer(emptyDetails.serverPid);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("zsh auto-start directly spawns the browser launcher without terminal injection", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-web-wrapper-test-"));
  const nodeLogPath = path.join(directory, "node.log");
  const codexLogPath = path.join(directory, "codex.log");
  const fakeNode = path.join(directory, "node");
  const fakeCodex = path.join(directory, "codex");
  fs.writeFileSync(fakeNode, `#!/bin/sh
printf '%s\\n' "$*" > "$WRAPPER_NODE_LOG"
`, { mode: 0o755 });
  fs.writeFileSync(fakeCodex, `#!/bin/sh
printf '%s\\n' "$*" > "$WRAPPER_CODEX_LOG"
`, { mode: 0o755 });
  const script = `source ${JSON.stringify(autoStart)}; codex --yolo`;
  const result = spawnSync("/bin/zsh", ["-dfc", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:/usr/bin:/bin`,
      CMUX_SURFACE_ID: "source-wrapper",
      CMUX_WORKSPACE_ID: "workspace-wrapper",
      CODEX_STREAM_NODE_PATH: fakeNode,
      CODEX_STREAM_AUTO_LAUNCHER: "/test/browser-launcher.mjs",
      CODEX_STREAM_LOG_DIRECTORY: directory,
      WRAPPER_NODE_LOG: nodeLogPath,
      WRAPPER_CODEX_LOG: codexLogPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(waitForFile(nodeLogPath), true, "The browser launcher was not spawned");
  assert.equal(fs.readFileSync(nodeLogPath, "utf8").trim(), "/test/browser-launcher.mjs --auto");
  assert.equal(fs.readFileSync(codexLogPath, "utf8").trim(), "--yolo");
  const wrapperSource = fs.readFileSync(autoStart, "utf8");
  assert.doesNotMatch(wrapperSource, /cmux\s+(?:send|send-key)|print\s+-z|eval/u);
  fs.rmSync(directory, { recursive: true, force: true });
});
