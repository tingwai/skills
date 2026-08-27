import { isTranscriptBottom } from "./selection-state.js";

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const MINIMAP_WINDOW_VIEWPORTS = 8;
const DEFAULT_MINIMAP_SETTINGS = {
  windowViewports: 66.5,
  parallax: .35,
  focusGain: 5,
  focusRadius: 1.35,
  thumbScale: 1,
};

export function minimapWindow(
  scrollY,
  viewportHeight,
  documentHeight,
  windowViewports = MINIMAP_WINDOW_VIEWPORTS,
  parallax = 0,
) {
  const safeViewportHeight = Math.max(1, viewportHeight);
  const safeDocumentHeight = Math.max(safeViewportHeight, documentHeight);
  const maximumScroll = Math.max(0, safeDocumentHeight - safeViewportHeight);
  const boundedScrollY = clamp(scrollY, 0, maximumScroll);
  const span = Math.min(
    safeDocumentHeight,
    Math.max(safeViewportHeight, safeViewportHeight * windowViewports),
  );
  const viewportCenter = boundedScrollY + safeViewportHeight / 2;
  const centeredStart = clamp(viewportCenter - span / 2, 0, safeDocumentHeight - span);
  const scrollProgress = maximumScroll === 0 ? 0 : boundedScrollY / maximumScroll;
  const progressStart = scrollProgress * (safeDocumentHeight - span);
  const parallaxAmount = clamp(parallax);
  const start = centeredStart + (progressStart - centeredStart) * parallaxAmount;
  const heightRatio = safeViewportHeight / span;
  return {
    start,
    end: start + span,
    span,
    topRatio: clamp((boundedScrollY - start) / span, 0, 1 - heightRatio),
    heightRatio,
  };
}

export function minimapFocusMapper(
  center,
  viewportRatio,
  gain = DEFAULT_MINIMAP_SETTINGS.focusGain,
  radius = DEFAULT_MINIMAP_SETTINGS.focusRadius,
  steps = 720,
) {
  const safeGain = Math.max(0, gain);
  const sigma = Math.max(.02, viewportRatio * Math.max(.1, radius));
  const cumulative = new Float64Array(steps + 1);
  for (let index = 1; index <= steps; index += 1) {
    const point = (index - .5) / steps;
    cumulative[index] = cumulative[index - 1] +
      1 + safeGain * Math.exp(-(((point - center) / sigma) ** 2));
  }
  const total = cumulative[steps];
  const forward = (ratio) => {
    const scaled = clamp(ratio) * steps;
    const index = Math.min(steps - 1, Math.floor(scaled));
    const fraction = scaled - index;
    return (cumulative[index] + (cumulative[index + 1] - cumulative[index]) * fraction) / total;
  };
  const inverse = (target) => {
    let low = 0;
    let high = 1;
    for (let pass = 0; pass < 28; pass += 1) {
      const middle = (low + high) / 2;
      if (forward(middle) < clamp(target)) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  return { forward, inverse };
}

export function minimapViewport(scrollY, viewportHeight, documentHeight) {
  const { topRatio, heightRatio } = minimapWindow(scrollY, viewportHeight, documentHeight);
  return { topRatio, heightRatio };
}

export function eventIndexAtDocumentOffset(events, offset) {
  if (events.length === 0) return -1;
  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  events.forEach((event, index) => {
    const top = Number(event.top);
    const height = Math.max(0, Number(event.height) || 0);
    if (!Number.isFinite(top)) return;
    const bottom = top + height;
    const distance = offset < top ? top - offset : offset > bottom ? offset - bottom : 0;
    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  });
  return closestIndex;
}

export function sampleMinimap(events, maximumBins = 180) {
  if (events.length === 0) return [];
  const binCount = Math.min(events.length, maximumBins);
  return Array.from({ length: binCount }, (_, binIndex) => {
    const startIndex = Math.floor(binIndex * events.length / binCount);
    const endIndex = Math.max(startIndex, Math.floor((binIndex + 1) * events.length / binCount) - 1);
    const counts = new Map();
    const tops = [];
    const bottoms = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const kind = events[index].dataset?.kind ?? events[index].kind ?? "status";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      const top = Number(events[index].top);
      const height = Math.max(0, Number(events[index].height) || 0);
      if (Number.isFinite(top)) {
        tops.push(top);
        bottoms.push(top + height);
      }
    }
    const kind = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "status";
    return {
      startIndex,
      endIndex,
      count: endIndex - startIndex + 1,
      kind,
      top: tops.length ? Math.min(...tops) : null,
      bottom: bottoms.length ? Math.max(...bottoms) : null,
    };
  });
}

export function packMinimapBars(bars, railHeight, minimumHeight = 4) {
  const safeRailHeight = Math.max(0, railHeight);
  if (bars.length === 0 || safeRailHeight === 0) return [];
  const safeMinimumHeight = Math.min(
    safeRailHeight / bars.length,
    Math.max(0, minimumHeight),
  );
  const heights = bars.map((bar) => Math.max(
    safeMinimumHeight,
    Math.min(safeRailHeight, Number(bar.height) || 0),
  ));
  const totalHeight = heights.reduce((sum, height) => sum + height, 0);
  if (totalHeight > safeRailHeight) {
    const reducibleHeight = heights.reduce(
      (sum, height) => sum + height - safeMinimumHeight,
      0,
    );
    const overflow = totalHeight - safeRailHeight;
    if (reducibleHeight > 0) {
      heights.forEach((height, index) => {
        heights[index] = height - overflow * (height - safeMinimumHeight) / reducibleHeight;
      });
    }
  }

  const tops = bars.map((bar, index) => clamp(
    Number(bar.top) || 0,
    0,
    safeRailHeight - heights[index],
  ));
  for (let index = 1; index < tops.length; index += 1) {
    tops[index] = Math.max(tops[index], tops[index - 1] + heights[index - 1]);
  }
  const overflow = tops.at(-1) + heights.at(-1) - safeRailHeight;
  if (overflow > 0) tops[tops.length - 1] -= overflow;
  for (let index = tops.length - 2; index >= 0; index -= 1) {
    tops[index] = Math.min(tops[index], tops[index + 1] - heights[index]);
  }

  return bars.map((bar, index) => ({ ...bar, top: tops[index], height: heights[index] }));
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

export function installMinimap({ documentValue = document, windowValue = window, getEvents, navigate }) {
  const canvas = documentValue.querySelector("#minimap-canvas");
  const viewport = documentValue.querySelector("#minimap-viewport");
  if (!canvas || !viewport) return null;

  let framePending = false;
  let geometryVersion = 0;
  let renderedGeometryKey = "";
  const debugRoot = documentValue.querySelector("#minimap-debug-controls");
  const debugToggle = documentValue.querySelector("#toggle-minimap-debug");
  const debugSettings = { ...DEFAULT_MINIMAP_SETTINGS };

  const syncDebugVisibility = () => {
    if (!debugRoot || !debugToggle) return;
    debugRoot.hidden = !debugToggle.checked;
  };

  const syncDebugSettings = () => {
    if (!debugRoot) return;
    for (const input of debugRoot.querySelectorAll("[data-minimap-setting]")) {
      const key = input.dataset.minimapSetting;
      debugSettings[key] = Number(input.value);
      const output = debugRoot.querySelector(`[data-minimap-output="${key}"]`);
      if (!output) continue;
      const format = {
        windowViewports: (value) => `${value.toFixed(1)} viewports`,
        parallax: (value) => `${Math.round(value * 100)}%`,
        focusGain: (value) => `${value.toFixed(2)}×`,
        focusRadius: (value) => `${value.toFixed(2)} viewport`,
        thumbScale: (value) => `${value.toFixed(2)}×`,
      }[key];
      output.value = format ? format(debugSettings[key]) : String(debugSettings[key]);
      output.textContent = output.value;
    }
  };
  syncDebugSettings();
  syncDebugVisibility();

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

  const documentState = () => {
    const documentHeight = Math.max(windowValue.innerHeight, documentValue.documentElement.scrollHeight);
    const maximumScroll = Math.max(0, documentHeight - windowValue.innerHeight);
    return {
      documentHeight,
      maximumScroll,
    };
  };

  const projection = (state) => {
    const windowGeometry = minimapWindow(
      windowValue.scrollY,
      windowValue.innerHeight,
      state.documentHeight,
      debugSettings.windowViewports,
      debugSettings.parallax,
    );
    const viewportTop = clamp((windowValue.scrollY - windowGeometry.start) / windowGeometry.span);
    const viewportBottom = clamp(
      (windowValue.scrollY + windowValue.innerHeight - windowGeometry.start) / windowGeometry.span,
    );
    const focusMap = minimapFocusMapper(
      (viewportTop + viewportBottom) / 2,
      windowValue.innerHeight / windowGeometry.span,
      debugSettings.focusGain,
      debugSettings.focusRadius,
    );
    return { windowGeometry, focusMap, viewportTop, viewportBottom };
  };

  const updateViewport = () => {
    const state = documentState();
    const { focusMap, viewportTop, viewportBottom } = projection(state);
    const mappedTop = focusMap.forward(viewportTop);
    const mappedBottom = focusMap.forward(viewportBottom);
    const naturalHeight = mappedBottom - mappedTop;
    const heightRatio = clamp(naturalHeight * debugSettings.thumbScale, .02, 1);
    const atTop = windowValue.scrollY <= 1;
    const atBottom = state.maximumScroll - windowValue.scrollY <= 1;
    const centeredTop = (mappedTop + mappedBottom) / 2 - heightRatio / 2;
    const topRatio = atTop ? 0 : atBottom ? 1 - heightRatio : clamp(centeredTop, 0, 1 - heightRatio);
    viewport.style.top = `${topRatio * 100}%`;
    viewport.style.height = `${heightRatio * 100}%`;
    canvas.setAttribute("aria-valuenow", String(Math.round(
      clamp(windowValue.scrollY / Math.max(1, state.maximumScroll)) * 100,
    )));
  };

  const eventGeometry = (item) => {
    const rect = item.getBoundingClientRect();
    return {
      kind: item.dataset.kind,
      top: rect.top + windowValue.scrollY,
      height: rect.height,
    };
  };

  const draw = () => {
    framePending = false;
    const events = getEvents();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(11, rect.width || 14.4);
    const height = Math.max(120, Math.round(rect.height || 320));
    const state = documentState();
    const { windowGeometry, focusMap } = projection(state);
    const settingsKey = Object.values(debugSettings).join(":");
    const geometryKey = `${events.length}:${state.documentHeight}:${width}:${height}:${geometryVersion}:${Math.round(windowGeometry.start)}:${settingsKey}`;
    if (geometryKey !== renderedGeometryKey || canvas.width === 0) {
      renderedGeometryKey = geometryKey;
      const context = canvasContext(canvas, width, height, windowValue.devicePixelRatio);
      const palette = colors();
      const geometry = events.map(eventGeometry);
      const bins = sampleMinimap(geometry, Math.max(1, Math.floor(height / 4)));
      const barWidth = width - 2;
      const bars = [];
      bins.forEach((bin, index) => {
        const fallbackTop = index / Math.max(1, bins.length) * state.documentHeight;
        const fallbackBottom = (index + 1) / Math.max(1, bins.length) * state.documentHeight;
        const top = Math.max(windowGeometry.start, Number.isFinite(bin.top) ? bin.top : fallbackTop);
        const bottom = Math.min(windowGeometry.end, Number.isFinite(bin.bottom) ? bin.bottom : fallbackBottom);
        if (bottom <= top) return;
        const y = focusMap.forward((top - windowGeometry.start) / windowGeometry.span) * height;
        const mappedBottom = focusMap.forward(
          (bottom - windowGeometry.start) / windowGeometry.span,
        ) * height;
        const naturalHeight = Math.max(0, mappedBottom - y - .7);
        const barHeight = Math.max(4, naturalHeight);
        bars.push({
          kind: bin.kind,
          top: y + (naturalHeight - barHeight) / 2,
          height: barHeight,
        });
      });
      packMinimapBars(bars, height).forEach((bar) => {
        context.fillStyle = palette[bar.kind] ?? palette.other;
        context.globalAlpha = .68;
        context.fillRect(1, bar.top, barWidth, bar.height);
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

  const navigateToScrollTop = (scrollTop) => {
    const events = getEvents();
    const state = documentState();
    const boundedScrollTop = clamp(scrollTop, 0, state.maximumScroll);
    const geometry = events.map(eventGeometry);
    const index = eventIndexAtDocumentOffset(geometry, boundedScrollTop + windowValue.innerHeight / 2);
    navigate({
      index,
      scrollTop: boundedScrollTop,
      following: index >= 0
        && index === events.length - 1
        && isTranscriptBottom(boundedScrollTop, windowValue.innerHeight, state.documentHeight),
    });
  };

  const navigateAtPointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    const state = documentState();
    const { windowGeometry, focusMap } = projection(state);
    const windowRatio = focusMap.inverse(clamp((event.clientY - rect.top) / rect.height));
    const documentOffset = windowGeometry.start + windowRatio * windowGeometry.span;
    navigateToScrollTop(documentOffset - windowValue.innerHeight / 2);
  };

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    navigateAtPointer(event);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons === 1) navigateAtPointer(event);
  });
  canvas.addEventListener("keydown", (event) => {
    const state = documentState();
    const steps = {
      ArrowUp: -40,
      ArrowDown: 40,
      PageUp: -windowValue.innerHeight,
      PageDown: windowValue.innerHeight,
      Home: -Number.POSITIVE_INFINITY,
      End: Number.POSITIVE_INFINITY,
    };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const scrollTop = event.key === "Home" ? 0
      : event.key === "End" ? state.maximumScroll
      : windowValue.scrollY + steps[event.key];
    navigateToScrollTop(scrollTop);
  });

  windowValue.addEventListener("scroll", refresh, { passive: true });
  debugRoot?.addEventListener("input", () => {
    syncDebugSettings();
    geometryVersion += 1;
    refresh();
  });
  debugToggle?.addEventListener("change", syncDebugVisibility);
  windowValue.addEventListener("resize", () => {
    geometryVersion += 1;
    refresh();
  }, { passive: true });
  const stream = documentValue.querySelector("#stream");
  const geometryObserver = windowValue.ResizeObserver && stream
    ? new windowValue.ResizeObserver(() => {
      geometryVersion += 1;
      refresh();
    })
    : null;
  geometryObserver?.observe(stream);

  refresh();
  return { refresh };
}
