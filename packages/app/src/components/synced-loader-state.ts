const SYNCED_LOADER_DURATION_MS = 950;
export const SYNCED_LOADER_DOT_COUNT = 6;

const SYNCED_LOADER_OPACITY_STATES = [
  [1, 0, 0.78, 0, 0.56, 0.34],
  [0.78, 1, 0.56, 0, 0.34, 0],
  [0.56, 0.78, 0.34, 1, 0, 0],
  [0.34, 0.56, 0, 0.78, 0, 1],
  [0, 0.34, 0, 0.56, 1, 0.78],
  [0, 0, 1, 0.34, 0.78, 0.56],
] as const;

export function getSyncedLoaderStep(nowMs: number): number {
  "worklet";
  const elapsedMs = nowMs % SYNCED_LOADER_DURATION_MS;
  return Math.floor((elapsedMs * SYNCED_LOADER_DOT_COUNT) / SYNCED_LOADER_DURATION_MS);
}

export function getSyncedLoaderDotOpacity(step: number, dot: number): number {
  "worklet";
  return SYNCED_LOADER_OPACITY_STATES[step]?.[dot] ?? 0;
}
