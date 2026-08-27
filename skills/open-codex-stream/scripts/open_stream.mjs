#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

const rawArguments = process.argv.slice(2);
const browserRequested = rawArguments.includes("--browser");
const terminalRequested = rawArguments.includes("--terminal");
if (browserRequested && terminalRequested) fail("Choose either --browser or --terminal, not both");
const inHerdr = process.env.HERDR_ENV === "1";
const inCmux = !inHerdr && Boolean(process.env.CMUX_SURFACE_ID);
const mode = browserRequested ? "browser" : terminalRequested ? "terminal" : inCmux ? "browser" : "terminal";
const forwardedArguments = rawArguments.filter((argument) =>
  !["--browser", "--terminal"].includes(argument));

if (mode === "browser") {
  if (inHerdr) {
    fail("Browser Codex Stream is available only inside Cmux; use --terminal in Herdr");
  }
  if (!process.env.CMUX_SURFACE_ID) {
    fail("Browser Codex Stream must run inside a Cmux terminal");
  }
  const browserLauncher = process.env.CODEX_STREAM_BROWSER_LAUNCHER
    ?? path.join(import.meta.dirname, "open_web_stream_cmux.mjs");
  process.argv = [process.argv[0], browserLauncher, ...forwardedArguments];
  await import(browserLauncher);
  process.exit(process.exitCode ?? 0);
}

if (inCmux) {
  const terminalLauncher = process.env.CODEX_STREAM_TERMINAL_LAUNCHER
    ?? path.join(import.meta.dirname, "open_stream_cmux.mjs");
  process.argv = [process.argv[0], terminalLauncher, ...forwardedArguments];
  await import(terminalLauncher);
  process.exit(process.exitCode ?? 0);
}
if (!inHerdr) {
  process.stderr.write("This skill must run inside a Cmux or Herdr-managed terminal.\n");
  process.exit(1);
}

const preferredPluginId = "tingwai.agent-stream";
const legacyPluginId = "local.agent-stream";
const supportedPluginIds = [preferredPluginId, legacyPluginId];
const pluginSource = "tingwai/skills/herdr-plugins/agent-stream";
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const options = new Set(forwardedArguments);

for (const option of options) {
  if (!["--install", "--enable"].includes(option)) {
    fail(`Unknown option: ${option}`);
  }
}

function fail(message, details) {
  const suffix = details ? `: ${details}` : "";
  process.stderr.write(`${message}${suffix}\n`);
  process.exit(1);
}

function invoke(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) fail(`Could not run ${command}`, result.error.message);
  return result;
}

function herdrJson(args, allowFailure = false) {
  const result = invoke(herdr, args, { env: process.env });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(`Herdr command failed: herdr ${args.join(" ")}`, result.stderr.trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(`Herdr returned invalid JSON for: herdr ${args.join(" ")}`, error.message);
  }
}

function pluginViewerToRight(sourcePaneId, pluginRoot) {
  const neighborResult = herdrJson(
    ["pane", "neighbor", "--direction", "right", "--pane", sourcePaneId],
    true,
  );
  const viewerPaneId = neighborResult?.result?.neighbor?.neighbor_pane_id;
  if (!viewerPaneId) return null;

  const pane = herdrJson(["pane", "get", viewerPaneId])?.result?.pane;
  if (pane?.label !== "Codex stream" || pane.cwd !== pluginRoot) return null;

  const processes = herdrJson(["pane", "process-info", "--pane", viewerPaneId])
    ?.result?.process_info?.foreground_processes ?? [];
  const isViewer = processes.some((process) =>
    process.name === "node"
    && process.argv?.some((argument) => path.basename(argument) === "tui.mjs")
  );
  return isViewer ? viewerPaneId : null;
}

function listPlugins() {
  return herdrJson(["plugin", "list", "--json"])?.result?.plugins ?? [];
}

function resolvePlugin(plugins) {
  const supported = supportedPluginIds
    .map((pluginId) => plugins.find((plugin) => plugin.plugin_id === pluginId))
    .filter(Boolean);
  return supported.find((plugin) => plugin.enabled) ?? supported[0] ?? null;
}

function writeResult(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

const sourcePane = herdrJson(["pane", "current", "--current"])?.result?.pane;
if (!sourcePane?.pane_id) fail("Herdr did not resolve the calling pane");
if (
  sourcePane.agent_session?.agent !== "codex"
  || sourcePane.agent_session?.kind !== "id"
) {
  fail(`Pane ${sourcePane.pane_id} is not a recognized Codex session`);
}

let plugin = resolvePlugin(listPlugins());
if (!plugin && !options.has("--install")) {
  writeResult({
    status: "plugin_missing",
    plugin_id: preferredPluginId,
    install_command: `herdr plugin install ${pluginSource} --yes`,
  }, 2);
}
if (!plugin) {
  const installResult = invoke(
    herdr,
    ["plugin", "install", pluginSource, "--yes"],
    { env: process.env },
  );
  if (installResult.status !== 0) {
    fail(`Could not install Herdr plugin ${preferredPluginId}`, installResult.stderr.trim());
  }
  plugin = resolvePlugin(listPlugins());
  if (!plugin) fail(`Herdr installed ${pluginSource} but did not register ${preferredPluginId}`);
}
if (!plugin.enabled && !options.has("--enable")) {
  writeResult({
    status: "plugin_disabled",
    plugin_id: plugin.plugin_id,
    enable_command: `herdr plugin enable ${plugin.plugin_id}`,
  }, 2);
}
if (!plugin.enabled) {
  const enableResult = invoke(
    herdr,
    ["plugin", "enable", plugin.plugin_id],
    { env: process.env },
  );
  if (enableResult.status !== 0) {
    fail(`Could not enable Herdr plugin ${plugin.plugin_id}`, enableResult.stderr.trim());
  }
  plugin = resolvePlugin(listPlugins());
  if (!plugin?.enabled) fail("Herdr did not report the plugin as enabled");
}
if (!plugin.plugin_root) fail(`Herdr plugin ${plugin.plugin_id} has no plugin root`);

const existingViewerPaneId = pluginViewerToRight(
  sourcePane.pane_id,
  plugin.plugin_root,
);
if (existingViewerPaneId) {
  writeResult({
    status: "already_open",
    plugin_id: plugin.plugin_id,
    source_pane_id: sourcePane.pane_id,
    viewer_pane_id: existingViewerPaneId,
  });
}

const event = plugin.events?.find((candidate) =>
  candidate.on === "pane.agent_detected" && candidate.command?.length > 0
);
if (!event) fail(`Herdr plugin ${plugin.plugin_id} has no pane.agent_detected entrypoint`);

const eventResult = invoke(event.command[0], event.command.slice(1), {
  cwd: plugin.plugin_root,
  env: {
    ...process.env,
    HERDR_BIN_PATH: herdr,
    HERDR_ENV: "1",
    HERDR_PANE_ID: sourcePane.pane_id,
    HERDR_PLUGIN_ROOT: plugin.plugin_root,
  },
});
if (eventResult.status !== 0) {
  fail(`The ${plugin.plugin_id} launch entrypoint failed`, eventResult.stderr.trim());
}

let viewerPaneId = null;
for (let attempt = 0; attempt < 30 && !viewerPaneId; attempt += 1) {
  viewerPaneId = pluginViewerToRight(sourcePane.pane_id, plugin.plugin_root);
  if (!viewerPaneId) await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!viewerPaneId) {
  fail(`The ${plugin.plugin_id} viewer did not appear to the right of ${sourcePane.pane_id}`);
}

writeResult({
  status: "opened",
  plugin_id: plugin.plugin_id,
  source_pane_id: sourcePane.pane_id,
  viewer_pane_id: viewerPaneId,
});
