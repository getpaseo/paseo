export function normalizeProviderReplayTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const timestamp = value.trim();
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      return null;
    }
    return timestamp;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const timestampMs = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
