import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptsDirectory = path.resolve(import.meta.dirname, "../scripts");
const lifecycleModulePath = path.resolve(
  scriptsDirectory,
  "../../../herdr-plugins/agent-stream/viewer-lifecycle.mjs",
);
const renderingModulePath = path.resolve(
  scriptsDirectory,
  "../../../herdr-plugins/agent-stream/viewer-rendering.mjs",
);

function executable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
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

test("Cmux launcher opens right without focus and restores the same surface", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-stream-launcher-test-"));
  const sourceSurfaceId = `source-${process.pid}-${Date.now()}`;
  const logPath = path.join(directory, "cmux.log");
  const fakeCmux = path.join(directory, "cmux");
  const fakeViewer = path.join(directory, "cmux_stream.mjs");
  const statePath = path.join(directory, `${sourceSurfaceId}.json`);
  fs.writeFileSync(fakeViewer, `
import fs from "node:fs";
fs.writeFileSync(process.env.CMUX_TEST_STATE, JSON.stringify({
  runtime: "cmux",
  sourceSurfaceId: process.env.CMUX_SURFACE_ID,
  viewerSurfaceId: "viewer-test",
  pid: process.pid,
}));
setInterval(() => {}, 1_000);
`);
  executable(fakeCmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$CMUX_TEST_LOG"
case " $* " in
  *" new-split "*) printf '%s\\n' '{"surface_id":"viewer-test"}' ;;
  *" read-screen "*) exit 0 ;;
  *" send "*) nohup "$CMUX_TEST_NODE" "$CMUX_TEST_VIEWER" >/dev/null 2>&1 & ;;
esac
`);

  const env = {
    ...process.env,
    CMUX_BIN_PATH: fakeCmux,
    CMUX_SURFACE_ID: sourceSurfaceId,
    CMUX_WORKSPACE_ID: "workspace-test",
    CMUX_TEST_LOG: logPath,
    CMUX_TEST_NODE: process.execPath,
    CMUX_TEST_STATE: statePath,
    CMUX_TEST_VIEWER: fakeViewer,
    AGENT_STREAM_STATE_DIRECTORY: directory,
  };
  const launcher = path.join(scriptsDirectory, "open_stream.mjs");
  const first = spawnSync(process.execPath, [launcher], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, "opened");

  const second = spawnSync(process.execPath, [launcher], { encoding: "utf8", env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, "already_open");

  const firstViewerPid = JSON.parse(fs.readFileSync(statePath, "utf8")).pid;
  process.kill(firstViewerPid, "SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(firstViewerPid, 0);
    } catch {
      break;
    }
  }

  const third = spawnSync(process.execPath, [launcher], { encoding: "utf8", env });
  assert.equal(third.status, 0, third.stderr);
  assert.equal(JSON.parse(third.stdout).status, "restored");

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /new-split right/);
  assert.match(log, /--surface source-/);
  assert.match(log, /--focus false/);
  assert.equal((log.match(/new-split right/g) ?? []).length, 1);

  const secondViewerPid = JSON.parse(fs.readFileSync(statePath, "utf8")).pid;
  process.kill(secondViewerPid, "SIGTERM");

  fs.rmSync(directory, { recursive: true, force: true });
});

test("Cmux viewer selects the surface-scoped transcript", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-stream-viewer-test-"));
  const transcriptPath = path.join(directory, "session.jsonl");
  const resultPath = path.join(directory, "viewer.json");
  const statePath = path.join(directory, "state.json");
  const fakeCmux = path.join(directory, "cmux");
  const fakeViewer = path.join(directory, "viewer.mjs");
  fs.writeFileSync(transcriptPath, "{}\n");
  executable(fakeCmux, `#!/bin/sh
printf '%s\\n' '{"sessions":[{"session_id":"session-test","surface_id":"source-test","active_for_surface":true,"updated_at_unix":9999999999,"codex_transcript_path":"${transcriptPath}"}]}'
`);
  fs.writeFileSync(fakeViewer, `
import fs from "node:fs";
fs.writeFileSync(process.env.CMUX_TEST_RESULT, JSON.stringify({
  sessionId: process.env.CODEX_SESSION_ID,
  transcriptPath: process.env.CODEX_TRANSCRIPT_PATH,
  sourceSurfaceId: process.env.CODEX_SOURCE_PANE_ID,
}));
`);

  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, "cmux_stream.mjs"),
    "--source-surface", "source-test",
    "--viewer-surface", "viewer-test",
    "--not-before", "1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_STREAM_STATE_PATH: statePath,
      AGENT_STREAM_TUI_PATH: fakeViewer,
      CMUX_BIN_PATH: fakeCmux,
      CMUX_TEST_RESULT: resultPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), {
    sessionId: "session-test",
    transcriptPath,
    sourceSurfaceId: "source-test",
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Cmux viewer uses the shared framed Herdr empty state while waiting", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-stream-empty-test-"));
  const fakeCmux = path.join(directory, "cmux");
  executable(fakeCmux, `#!/bin/sh
printf '%s\\n' '{"sessions":[]}'
`);
  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, "cmux_stream.mjs"),
    "--source-surface", "source-test",
    "--viewer-surface", "viewer-test",
    "--not-before", "1",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_STREAM_SESSION_WAIT_ATTEMPTS: "1",
      AGENT_STREAM_STATE_PATH: path.join(directory, "state.json"),
      CMUX_BIN_PATH: fakeCmux,
    },
  });
  assert.equal(result.status, 1);
  const rendering = await import(renderingModulePath);
  const sharedEmptyState = rendering.enterEmptyState(undefined, undefined);
  assert.equal(result.stdout, `${sharedEmptyState}\u001b[?25h\u001b[?1049l`);
  const visibleFrame = sharedEmptyState
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/gu, "")
    .split("\n");
  assert.equal(visibleFrame.length, 24);
  assert.equal(visibleFrame[0].trim(), rendering.VIEWER_HELP.trim());
  assert.equal(visibleFrame.at(-1).trim(), rendering.EMPTY_STATE_MESSAGE.trim());
  assert.match(result.stdout, /Nothing to display yet\./u);
  assert.match(result.stdout, /click selects · wheel scrolls chat/u);
  assert.doesNotMatch(result.stdout, /\$|%/u);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("lowercase q closes only its dedicated Cmux viewer surface", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-stream-quit-test-"));
  const closeLogPath = path.join(directory, "close.log");
  const fakeCmux = path.join(directory, "cmux");
  executable(fakeCmux, `#!/bin/sh
printf '%s\\n' "$*" >> "$CMUX_TEST_CLOSE_LOG"
`);
  const lifecycle = await import(lifecycleModulePath);
  const dedicatedEnvironment = {
    ...process.env,
    AGENT_STREAM_RUNTIME: "cmux",
    CMUX_AGENT_STREAM_VIEWER_SURFACE_ID: "viewer-test",
    CMUX_BIN_PATH: fakeCmux,
    CMUX_SURFACE_ID: "viewer-test",
    CMUX_TEST_CLOSE_LOG: closeLogPath,
  };
  assert.equal(lifecycle.shouldCloseCmuxViewer("q", dedicatedEnvironment), true);
  assert.equal(lifecycle.shouldCloseCmuxViewer("\u0003", dedicatedEnvironment), false);
  assert.equal(lifecycle.requestCmuxViewerClose(dedicatedEnvironment), true);
  assert.equal(waitForFile(closeLogPath), true, "Cmux close command was not invoked");
  assert.match(fs.readFileSync(closeLogPath, "utf8"), /^close-surface --surface viewer-test$/mu);

  fs.rmSync(closeLogPath, { force: true });
  const mismatchedEnvironment = { ...dedicatedEnvironment, CMUX_SURFACE_ID: "ordinary-shell" };
  assert.equal(lifecycle.shouldCloseCmuxViewer("q", mismatchedEnvironment), false);
  assert.equal(lifecycle.requestCmuxViewerClose(mismatchedEnvironment), false);
  const herdrEnvironment = { ...dedicatedEnvironment, AGENT_STREAM_RUNTIME: "herdr" };
  assert.equal(lifecycle.shouldCloseCmuxViewer("q", herdrEnvironment), false);
  assert.equal(lifecycle.requestCmuxViewerClose(herdrEnvironment), false);
  assert.equal(fs.existsSync(closeLogPath), false, "A non-viewer Cmux surface was closed");
  fs.rmSync(directory, { recursive: true, force: true });
});
