function boundedIndex(index, count) {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

export function selectionForNavigation(count, selectedIndex, direction) {
  if (count <= 0) return { selectedIndex: -1, following: true };
  const anchor = selectedIndex < 0 ? count - 1 : boundedIndex(selectedIndex, count);
  const nextIndex = boundedIndex(anchor + direction, count);
  return { selectedIndex: nextIndex, following: nextIndex === count - 1 };
}

export function selectionForIndex(count, selectedIndex) {
  if (count <= 0) return { selectedIndex: -1, following: true };
  const nextIndex = boundedIndex(selectedIndex, count);
  return { selectedIndex: nextIndex, following: nextIndex === count - 1 };
}

export function selectionAfterAppend(count, selectedIndex, following) {
  if (count <= 0) return { selectedIndex: -1, following: true };
  if (following) return { selectedIndex: count - 1, following: true };
  return { selectedIndex: boundedIndex(selectedIndex, count), following: false };
}

export function selectionForSessionReset() {
  return { selectedIndex: -1, following: true };
}

export function isLongEvent(eventHeight, viewportHeight, stickyTop) {
  const availableHeight = Math.max(0, viewportHeight - stickyTop);
  return availableHeight > 0 && eventHeight > availableHeight;
}

export function isTranscriptBottom(scrollY, viewportHeight, documentHeight, tolerance = 2) {
  return documentHeight - scrollY - viewportHeight <= tolerance;
}

export function followAfterScroll({
  following,
  previousScrollY,
  scrollY,
  viewportHeight,
  documentHeight,
}, tolerance = 2) {
  if (isTranscriptBottom(scrollY, viewportHeight, documentHeight, tolerance)) return true;
  if (following && scrollY < previousScrollY - tolerance) return false;
  if (following && documentHeight - scrollY - viewportHeight > 160) return false;
  return following;
}
