// The running loader is a 3x3 grid of dots. Each dot fades in, holds, and fades out, and the pulse
// runs down each column before it moves to the next column.
//
// These timings come from the desktop reference recording. A grid search over them matched its
// opacity waveform with a mean error under 0.06. Change them together, against a new recording.
export const SYNCED_LOADER_PERIOD_MS = 1064;
export const SYNCED_LOADER_FADE_IN_MS = 180;
export const SYNCED_LOADER_HOLD_MS = 160;
export const SYNCED_LOADER_FADE_OUT_MS = 192;
export const SYNCED_LOADER_PEAK_OPACITY = 0.5;
const DOT_DELAY_MS = 55;
const PULSE_MS = SYNCED_LOADER_FADE_IN_MS + SYNCED_LOADER_HOLD_MS + SYNCED_LOADER_FADE_OUT_MS;

export const SYNCED_LOADER_GRID_SIZE = 3;
export const SYNCED_LOADER_DOT_COUNT = SYNCED_LOADER_GRID_SIZE * SYNCED_LOADER_GRID_SIZE;

// The frame a loader holds when it does not animate (reduced motion, or a hidden retained panel):
// the first column lit and the second column starting to light.
export const SYNCED_LOADER_STILL_ELAPSED_MS = 260;

/** Dots are indexed row by row, but the pulse counts them column by column. */
export function getSyncedLoaderDotDelay(dot: number): number {
  "worklet";
  const row = Math.floor(dot / SYNCED_LOADER_GRID_SIZE);
  const column = dot % SYNCED_LOADER_GRID_SIZE;
  return (column * SYNCED_LOADER_GRID_SIZE + row) * DOT_DELAY_MS;
}

/**
 * The position in the cycle for a wall-clock time. Every loader reads the same clock, so a loader
 * that mounts mid-cycle is in phase with the loaders already on screen.
 */
export function getSyncedLoaderElapsed(nowMs: number): number {
  "worklet";
  return nowMs % SYNCED_LOADER_PERIOD_MS;
}

export function getSyncedLoaderDotOpacity(elapsedMs: number, dot: number): number {
  "worklet";
  const phase =
    (elapsedMs - getSyncedLoaderDotDelay(dot) + SYNCED_LOADER_PERIOD_MS) % SYNCED_LOADER_PERIOD_MS;

  if (phase >= PULSE_MS) {
    return 0;
  }
  if (phase < SYNCED_LOADER_FADE_IN_MS) {
    return (
      Math.sin(((phase / SYNCED_LOADER_FADE_IN_MS) * Math.PI) / 2) * SYNCED_LOADER_PEAK_OPACITY
    );
  }
  if (phase < SYNCED_LOADER_FADE_IN_MS + SYNCED_LOADER_HOLD_MS) {
    return SYNCED_LOADER_PEAK_OPACITY;
  }
  const fadeOutProgress =
    (phase - SYNCED_LOADER_FADE_IN_MS - SYNCED_LOADER_HOLD_MS) / SYNCED_LOADER_FADE_OUT_MS;
  return Math.cos((fadeOutProgress * Math.PI) / 2) * SYNCED_LOADER_PEAK_OPACITY;
}

export interface SyncedLoaderDotFrame {
  key: string;
  left: number;
  top: number;
  size: number;
}

/**
 * The grid fills `size` exactly. The dot size is what is left after the two gaps, not a floored
 * integer: flooring lost up to a third of a dot per row, and the mark read as too small for its
 * slot. Fractional dots are fine on a moving glyph this small.
 */
export function getSyncedLoaderDotFrames(size: number): SyncedLoaderDotFrame[] {
  const gap = Math.max(1, Math.round(size * 0.14));
  const dotSize = Math.max(
    2,
    (size - gap * (SYNCED_LOADER_GRID_SIZE - 1)) / SYNCED_LOADER_GRID_SIZE,
  );
  return Array.from({ length: SYNCED_LOADER_DOT_COUNT }, (_, dot) => ({
    key: `dot-${dot}`,
    left: (dot % SYNCED_LOADER_GRID_SIZE) * (dotSize + gap),
    top: Math.floor(dot / SYNCED_LOADER_GRID_SIZE) * (dotSize + gap),
    size: dotSize,
  }));
}
