const SYNCED_LOADER_HALF_CYCLE_MS = 900;

/** Triangle-wave progress in [0, 1] shared across all SyncedLoader instances. */
export function getSyncedLoaderProgress(nowMs: number): number {
  "worklet";
  const cycleMs = SYNCED_LOADER_HALF_CYCLE_MS * 2;
  const elapsedMs = ((nowMs % cycleMs) + cycleMs) % cycleMs;
  if (elapsedMs < SYNCED_LOADER_HALF_CYCLE_MS) {
    return elapsedMs / SYNCED_LOADER_HALF_CYCLE_MS;
  }
  return 1 - (elapsedMs - SYNCED_LOADER_HALF_CYCLE_MS) / SYNCED_LOADER_HALF_CYCLE_MS;
}

export function getSyncedLoaderPulse(progress: number): { opacity: number; scale: number } {
  "worklet";
  const t = Math.min(1, Math.max(0, progress));
  return {
    scale: 0.55 + t * 0.45,
    opacity: 0.28 + t * 0.72,
  };
}
