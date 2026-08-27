import fs from "node:fs";

export function normalizedCodexSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("codex-")
    ? sessionId.slice("codex-".length)
    : sessionId;
}

function hookSurfaceId(event) {
  return event.surface_id ?? event.surfaceId
    ?? event.payload?.surface_id ?? event.payload?.surfaceId;
}

function hookSessionId(event) {
  return event.payload?.session_id ?? event.payload?.sessionId
    ?? event.session_id ?? event.sessionId;
}

export function latestSurfaceHookSessionId(eventsPath, surfaceId, maximumBytes = 8 * 1024 * 1024) {
  if (!eventsPath || !surfaceId) return null;
  let descriptor;
  try {
    descriptor = fs.openSync(eventsPath, "r");
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - maximumBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]) continue;
      let event;
      try { event = JSON.parse(lines[index]); } catch { continue; }
      if (![
        "agent.hook.SessionStart",
        "agent.hook.UserPromptSubmit",
      ].includes(event.name)) continue;
      if (hookSurfaceId(event) !== surfaceId) continue;
      const sessionId = normalizedCodexSessionId(hookSessionId(event));
      if (sessionId) return sessionId;
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return null;
}

function sessionStartedAt(session) {
  const timestamp = Date.parse(session.started_at ?? session.startedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : Number(session.started_at_unix ?? 0);
}

export function selectSurfaceSession(sessions, surfaceId, hookSessionId = null, allowFallback = true) {
  const exact = sessions.filter((session) =>
    (session.surface_id ?? session.surfaceId) === surfaceId
    && (session.codex_transcript_path || session.transcript_path));
  const normalizedHookId = normalizedCodexSessionId(hookSessionId);
  const declaredActiveId = exact
    .map((session) => normalizedCodexSessionId(session.active_surface_session_id))
    .find(Boolean);
  return exact.find((session) =>
    normalizedCodexSessionId(session.session_id ?? session.sessionId) === normalizedHookId)
    ?? exact.find((session) => session.active_for_surface)
    ?? exact.find((session) =>
      declaredActiveId
      && normalizedCodexSessionId(session.session_id ?? session.sessionId) === declaredActiveId)
    ?? (allowFallback
      ? exact.sort((left, right) => sessionStartedAt(right) - sessionStartedAt(left))[0]
      : null)
    ?? null;
}
