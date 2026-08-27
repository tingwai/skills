import { spawn } from "node:child_process";

export const CMUX_CLOSE_EXIT_CODE = 73;

export function isDedicatedCmuxViewer(environment = process.env) {
  const viewerSurfaceId = environment.CMUX_AGENT_STREAM_VIEWER_SURFACE_ID;
  return environment.AGENT_STREAM_RUNTIME === "cmux"
    && Boolean(viewerSurfaceId)
    && environment.CMUX_SURFACE_ID === viewerSurfaceId;
}

export function shouldCloseCmuxViewer(keyboard, environment = process.env) {
  return keyboard === "q" && isDedicatedCmuxViewer(environment);
}

export function requestCmuxViewerClose(environment = process.env) {
  if (!isDedicatedCmuxViewer(environment)) return false;
  const viewerSurfaceId = environment.CMUX_AGENT_STREAM_VIEWER_SURFACE_ID;
  const cmux = environment.CMUX_BIN_PATH
    ?? environment.CMUX_BUNDLED_CLI_PATH
    ?? "/Applications/cmux.app/Contents/Resources/bin/cmux";
  try {
    const closer = spawn(cmux, ["close-surface", "--surface", viewerSurfaceId], {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    closer.on("error", () => {});
    closer.unref();
    return true;
  } catch {
    return false;
  }
}
