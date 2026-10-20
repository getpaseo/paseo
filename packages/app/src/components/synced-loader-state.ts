export const SYNCED_LOADER_DURATION_MS = 1064;
export const SYNCED_LOADER_DOT_COUNT = 9;
export const SYNCED_LOADER_GRID_COLUMNS = 3;
export const SYNCED_LOADER_MAX_OPACITY = 0.5;
export const SYNCED_LOADER_REDUCED_MOTION_ELAPSED_MS = 260;

const DOT_DELAY_MS = 55;
const FADE_IN_MS = 180;
const HOLD_MS = 160;
const FADE_OUT_MS = 192;
const PULSE_DURATION_MS = FADE_IN_MS + HOLD_MS + FADE_OUT_MS;

/**
 * The loader is a diagonal pulse across a 3x3 grid. Column-major delays make the pulse travel
 * down each column before moving right, which is the shape used by the desktop reference. Keep
 * this clock-based rather than step-based: the soft fade is part of the mark, not a transition
 * between six static frames.
 */
export function getSyncedLoaderElapsed(nowMs: number): number {
  "worklet";
  return (
    ((nowMs % SYNCED_LOADER_DURATION_MS) + SYNCED_LOADER_DURATION_MS) % SYNCED_LOADER_DURATION_MS
  );
}

export function getSyncedLoaderDotOpacity(elapsedMs: number, dot: number): number {
  "worklet";
  const row = Math.floor(dot / SYNCED_LOADER_GRID_COLUMNS);
  const column = dot % SYNCED_LOADER_GRID_COLUMNS;
  const delay = (column * SYNCED_LOADER_GRID_COLUMNS + row) * DOT_DELAY_MS;
  const phase = (elapsedMs - delay + SYNCED_LOADER_DURATION_MS) % SYNCED_LOADER_DURATION_MS;

  if (phase >= PULSE_DURATION_MS) {
    return 0;
  }
  if (phase < FADE_IN_MS) {
    const progress = phase / FADE_IN_MS;
    return Math.sin((progress * Math.PI) / 2) * SYNCED_LOADER_MAX_OPACITY;
  }
  if (phase < FADE_IN_MS + HOLD_MS) {
    return SYNCED_LOADER_MAX_OPACITY;
  }

  const progress = (phase - FADE_IN_MS - HOLD_MS) / FADE_OUT_MS;
  return Math.cos((progress * Math.PI) / 2) * SYNCED_LOADER_MAX_OPACITY;
}
