/** Matches the web composer `lineHeight` (`theme.fontSize.content * 1.4`). */
export const COMPOSER_INPUT_LINE_HEIGHT = 15 * 1.4;

export const DEFAULT_MAX_INPUT_HEIGHT = 160;
export const COMPACT_MAX_INPUT_LINES = 10;
export const COMPACT_MIN_INPUT_LINES = 3;
export const COMPACT_MAX_AVAILABLE_RATIO = 0.3;
export const DESKTOP_MAX_VIEWPORT_RATIO = 0.5;

export interface ResolveMaxInputHeightInput {
  windowHeight: number;
  isCompact: boolean;
  /** Settled iOS keyboard overlap. Android resize already shrinks the window. */
  keyboardInset?: number;
}

function lineHeightCap(lines: number): number {
  return Math.ceil(COMPOSER_INPUT_LINE_HEIGHT * lines);
}

function resolvedKeyboardInset(keyboardInset: number | undefined): number {
  if (keyboardInset === undefined || !Number.isFinite(keyboardInset) || keyboardInset <= 0) {
    return 0;
  }
  return keyboardInset;
}

export function resolveMaxInputHeight(input: ResolveMaxInputHeightInput): number {
  if (!Number.isFinite(input.windowHeight) || input.windowHeight <= 0) {
    return DEFAULT_MAX_INPUT_HEIGHT;
  }

  if (!input.isCompact) {
    return Math.max(
      DEFAULT_MAX_INPUT_HEIGHT,
      Math.floor(input.windowHeight * DESKTOP_MAX_VIEWPORT_RATIO),
    );
  }

  // Ten lines is the ceiling. 30% of the remaining window is the ceiling once
  // iOS overlays the keyboard. Android resize already shrinks windowHeight, so
  // callers pass 0 inset there.
  const lineCap = lineHeightCap(COMPACT_MAX_INPUT_LINES);
  const minCap = lineHeightCap(COMPACT_MIN_INPUT_LINES);
  const availableHeight = Math.max(
    0,
    input.windowHeight - resolvedKeyboardInset(input.keyboardInset),
  );
  const availableCap = Math.floor(availableHeight * COMPACT_MAX_AVAILABLE_RATIO);
  if (availableCap <= 0) return minCap;
  return Math.max(minCap, Math.min(lineCap, availableCap));
}
