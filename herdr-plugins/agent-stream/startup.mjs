import { spawnSync } from "node:child_process";
import path from "node:path";

function collectCodexPaneIds(value, paneIds = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectCodexPaneIds(item, paneIds);
    return paneIds;
  }
  if (!value || typeof value !== "object") return paneIds;

  if (
    typeof value.id === "string"
    && value.agent_session?.agent === "codex"
    && value.agent_session?.kind === "id"
  ) {
    paneIds.add(value.id);
  }
  for (const nestedValue of Object.values(value)) {
    collectCodexPaneIds(nestedValue, paneIds);
  }
  return paneIds;
}

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const snapshotResult = spawnSync(herdr, ["api", "snapshot"], {
  encoding: "utf8",
  env: process.env,
  timeout: 5_000,
});
if (snapshotResult.status !== 0) process.exit(0);

let snapshot;
try {
  snapshot = JSON.parse(snapshotResult.stdout);
} catch {
  process.exit(0);
}

const eventScript = path.join(
  process.env.HERDR_PLUGIN_ROOT ?? import.meta.dirname,
  "agent-event.mjs",
);
for (const paneId of collectCodexPaneIds(snapshot)) {
  spawnSync(process.execPath, [eventScript], {
    encoding: "utf8",
    env: { ...process.env, HERDR_ENV: "1", HERDR_PANE_ID: paneId },
    timeout: 8_000,
  });
}
