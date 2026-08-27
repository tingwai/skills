const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MINIMUM_WIDTH = 20;
const MINIMUM_HEIGHT = 6;
const CSI = "\u001b[";
const RESET = `${CSI}0m`;

export const EMPTY_STATE_MESSAGE = " Nothing to display yet.";
export const VIEWER_HELP = " click selects · wheel scrolls chat · Shift+wheel message · j/k · G live";

function clip(text, width) {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + "…";
}

export function viewerDimensions(columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS) {
  return {
    width: Math.max(MINIMUM_WIDTH, (columns || DEFAULT_COLUMNS) - 1),
    height: Math.max(MINIMUM_HEIGHT, rows || DEFAULT_ROWS),
  };
}

export function renderEmptyState(columns, rows) {
  const { width, height } = viewerDimensions(columns, rows);
  const viewportHeight = Math.max(1, height - 2);
  const help = clip(VIEWER_HELP, width).padEnd(width);
  const message = clip(EMPTY_STATE_MESSAGE, width).padEnd(width);
  return [
    `${CSI}H${CSI}2J${CSI}2;37m${help}${RESET}`,
    ...Array.from({ length: viewportHeight }, () => " ".repeat(width)),
    `${CSI}38;5;246m${message}${RESET}`,
  ].join("\n");
}

export function enterEmptyState(columns, rows) {
  return `${CSI}?1049h${CSI}?25l${renderEmptyState(columns, rows)}`;
}
