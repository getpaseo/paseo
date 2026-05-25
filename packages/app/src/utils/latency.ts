export function formatLatency(latencyMs: number): string {
  if (latencyMs < 1) {
    return `${Math.round(latencyMs * 1000)}\u00b5s`;
  }

  if (latencyMs < 1000) {
    return `${Math.round(latencyMs)}ms`;
  }

  const seconds = latencyMs / 1000;
  const roundedSeconds = Math.round(seconds * 10) / 10;
  return Number.isInteger(roundedSeconds) ? `${roundedSeconds}s` : `${roundedSeconds.toFixed(1)}s`;
}
