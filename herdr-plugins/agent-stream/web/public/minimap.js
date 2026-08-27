export function minimapIndexForRatio(count, ratio) {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.round(Math.max(0, Math.min(1, ratio)) * (count - 1))));
}

export function minimapViewport(scrollY, viewportHeight, documentHeight) {
  const safeDocumentHeight = Math.max(viewportHeight, documentHeight);
  const maximumScroll = Math.max(1, safeDocumentHeight - viewportHeight);
  return {
    topRatio: Math.max(0, Math.min(1, scrollY / maximumScroll)),
    heightRatio: Math.max(.04, Math.min(1, viewportHeight / safeDocumentHeight)),
  };
}

export function sampleMinimap(events, maximumBins = 180) {
  if (events.length === 0) return [];
  const binCount = Math.min(events.length, maximumBins);
  return Array.from({ length: binCount }, (_, binIndex) => {
    const startIndex = Math.floor(binIndex * events.length / binCount);
    const endIndex = Math.max(startIndex, Math.floor((binIndex + 1) * events.length / binCount) - 1);
    const counts = new Map();
    for (let index = startIndex; index <= endIndex; index += 1) {
      const kind = events[index].dataset?.kind ?? events[index].kind ?? "status";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const kind = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "status";
    return { startIndex, endIndex, count: endIndex - startIndex + 1, kind };
  });
}

function canvasContext(canvas, width, height, devicePixelRatio) {
  const ratio = Math.max(1, devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

export function installMinimap({
  documentValue = document,
  windowValue = window,
  getEvents,
  selectIndex,
}) {
  const canvas = documentValue.querySelector("#minimap-canvas");
  const viewport = documentValue.querySelector("#minimap-viewport");
  if (!canvas || !viewport) return null;

  let framePending = false;
  let renderedEventCount = -1;

  const colors = () => {
    const style = windowValue.getComputedStyle(documentValue.documentElement);
    return {
      user: style.getPropertyValue("--user").trim() || "#9faefc",
      agent: style.getPropertyValue("--agent").trim() || "#67b7c7",
      command: style.getPropertyValue("--command").trim() || "#d5b873",
      reasoning: style.getPropertyValue("--reasoning").trim() || "#a8a0d6",
      change: style.getPropertyValue("--change").trim() || "#d18eb2",
      extension: style.getPropertyValue("--output").trim() || "#78adca",
      other: style.getPropertyValue("--muted").trim() || "#8c9aad",
    };
  };

  const updateViewport = () => {
    const documentHeight = Math.max(windowValue.innerHeight, documentValue.documentElement.scrollHeight);
    const range = minimapViewport(windowValue.scrollY, windowValue.innerHeight, documentHeight);
    viewport.style.top = `${range.topRatio * 100}%`;
    viewport.style.height = `${range.heightRatio * 100}%`;
  };

  const draw = () => {
    framePending = false;
    const events = getEvents();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(14, Math.round(rect.width || 16));
    const height = Math.max(120, Math.round(rect.height || 320));
    if (events.length !== renderedEventCount || canvas.width === 0) {
      renderedEventCount = events.length;
      const context = canvasContext(canvas, width, height, windowValue.devicePixelRatio);
      const palette = colors();
      const bins = sampleMinimap(events);
      const binHeight = height / Math.max(1, bins.length);
      bins.forEach((bin, index) => {
        context.fillStyle = palette[bin.kind] ?? palette.other;
        context.globalAlpha = .78;
        context.fillRect(1, index * binHeight, width - 2, Math.max(1, binHeight - .5));
      });
      context.globalAlpha = 1;
    }
    updateViewport();
  };

  const refresh = () => {
    if (framePending) return;
    framePending = true;
    windowValue.requestAnimationFrame(draw);
  };

  const selectAtPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    const index = minimapIndexForRatio(getEvents().length, (event.clientY - rect.top) / rect.height);
    if (index >= 0) selectIndex(index);
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    selectAtPointer(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons === 1) selectAtPointer(event);
  });
  windowValue.addEventListener("scroll", updateViewport, { passive: true });
  windowValue.addEventListener("resize", () => {
    renderedEventCount = -1;
    refresh();
  }, { passive: true });

  refresh();
  return { refresh };
}
