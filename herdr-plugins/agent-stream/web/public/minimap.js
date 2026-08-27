import { isTranscriptBottom } from "./selection-state.js";

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));

export function minimapViewport(scrollY, viewportHeight, documentHeight) {
  const safeDocumentHeight = Math.max(viewportHeight, documentHeight);
  const maximumScroll = Math.max(1, safeDocumentHeight - viewportHeight);
  return {
    topRatio: clamp(scrollY / maximumScroll),
    heightRatio: Math.max(.04, Math.min(1, viewportHeight / safeDocumentHeight)),
  };
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
    const lengths = [];
    const tops = [];
    const bottoms = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const kind = events[index].dataset?.kind ?? events[index].kind ?? "status";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      const length = Number(events[index].dataset?.contentLength ?? events[index].contentLength ?? 0);
      lengths.push(Number.isFinite(length) && length > 0 ? length : 0);
      const top = Number(events[index].top);
      const height = Math.max(0, Number(events[index].height) || 0);
      if (Number.isFinite(top)) {
        tops.push(top);
        bottoms.push(top + height);
      }
    }
    const kind = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "status";
    lengths.sort((left, right) => left - right);
    const middle = Math.floor(lengths.length / 2);
    const aggregateLength = lengths.length % 2 === 0
      ? (lengths[middle - 1] + lengths[middle]) / 2
      : lengths[middle];
    return {
      startIndex,
      endIndex,
      count: endIndex - startIndex + 1,
      kind,
      aggregateLength,
      top: tops.length ? Math.min(...tops) : null,
      bottom: bottoms.length ? Math.max(...bottoms) : null,
    };
  });
}

export function minimapBarWidths(bins, railWidth, minimumWidth = 2) {
  const safeRailWidth = Math.max(1, railWidth);
  const safeMinimum = Math.min(safeRailWidth, Math.max(1, minimumWidth));
  const maximumLength = Math.max(0, ...bins.map((bin) => bin.aggregateLength ?? 0));
  const denominator = Math.log1p(maximumLength);
  return bins.map((bin) => {
    const length = Math.max(0, bin.aggregateLength ?? 0);
    if (denominator === 0 || length === 0) return safeMinimum;
    return safeMinimum + (safeRailWidth - safeMinimum) * Math.log1p(length) / denominator;
  });
}

export function lensMapper(center, viewportRatio, steps = 720) {
  const gain = 5.5;
  const sigma = Math.max(.035, viewportRatio * .55);
  const cumulative = new Float64Array(steps + 1);
  for (let index = 1; index <= steps; index += 1) {
    const point = (index - .5) / steps;
    cumulative[index] = cumulative[index - 1] +
      1 + gain * Math.exp(-(((point - center) / sigma) ** 2));
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
  let currentMap = null;

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
      top: windowValue.scrollY / documentHeight,
      bottom: clamp((windowValue.scrollY + windowValue.innerHeight) / documentHeight),
      center: clamp((windowValue.scrollY + windowValue.innerHeight / 2) / documentHeight),
      viewportRatio: clamp(windowValue.innerHeight / documentHeight),
    };
  };

  const updateViewport = () => {
    const state = documentState();
    const mappedTop = currentMap?.forward(state.top) ?? state.top;
    const mappedBottom = currentMap?.forward(state.bottom) ?? state.bottom;
    viewport.style.top = `${mappedTop * 100}%`;
    viewport.style.height = `${Math.max(.02, mappedBottom - mappedTop) * 100}%`;
    canvas.setAttribute("aria-valuenow", String(Math.round(
      clamp(windowValue.scrollY / Math.max(1, state.maximumScroll)) * 100,
    )));
  };

  const eventGeometry = (item) => {
    const rect = item.getBoundingClientRect();
    return {
      kind: item.dataset.kind,
      contentLength: Number(item.dataset.contentLength),
      top: rect.top + windowValue.scrollY,
      height: rect.height,
    };
  };

  const draw = () => {
    framePending = false;
    const events = getEvents();
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(14, Math.round(rect.width || 16));
    const height = Math.max(120, Math.round(rect.height || 320));
    const state = documentState();
    const geometryKey = `${events.length}:${state.documentHeight}:${width}:${height}:${geometryVersion}:${Math.round(windowValue.scrollY)}`;
    if (geometryKey !== renderedGeometryKey || canvas.width === 0) {
      renderedGeometryKey = geometryKey;
      const context = canvasContext(canvas, width, height, windowValue.devicePixelRatio);
      const palette = colors();
      const bins = sampleMinimap(events.map(eventGeometry));
      const widths = minimapBarWidths(bins, width - 2);
      currentMap = lensMapper(state.center, state.viewportRatio);
      bins.forEach((bin, index) => {
        const fallbackTop = index / Math.max(1, bins.length) * state.documentHeight;
        const fallbackBottom = (index + 1) / Math.max(1, bins.length) * state.documentHeight;
        const top = Number.isFinite(bin.top) ? bin.top : fallbackTop;
        const bottom = Number.isFinite(bin.bottom) ? bin.bottom : fallbackBottom;
        const y = currentMap.forward(top / state.documentHeight) * height;
        const mappedBottom = currentMap.forward(bottom / state.documentHeight) * height;
        const barWidth = widths[index];
        context.fillStyle = palette[bin.kind] ?? palette.other;
        context.globalAlpha = .68;
        context.fillRect(width - barWidth - 1, y, barWidth, Math.max(1.5, mappedBottom - y - .7));
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
    const documentRatio = currentMap?.inverse(clamp((event.clientY - rect.top) / rect.height)) ?? 0;
    navigateToScrollTop(documentRatio * state.documentHeight - windowValue.innerHeight / 2);
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
  windowValue.addEventListener("resize", () => {
    geometryVersion += 1;
    refresh();
  }, { passive: true });
  const transcript = documentValue.querySelector("#tape");
  const geometryObserver = windowValue.ResizeObserver && transcript
    ? new windowValue.ResizeObserver(() => {
      geometryVersion += 1;
      refresh();
    })
    : null;
  geometryObserver?.observe(transcript);

  refresh();
  return { refresh };
}
