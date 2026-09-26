/**
 * Minimal MSP view-item shape consumed from `muse serve`. The SDK barrel does
 * not export its generated wire types, so this covers only the fields Paseo
 * reads; every consumer validates before trusting them.
 */
export interface MuseViewItem {
  readonly itemId: string;
  readonly revision: number;
  readonly kind?: unknown;
  readonly turnId?: unknown;
  readonly commandId?: unknown;
  readonly status?: unknown;
  readonly text?: unknown;
  readonly displayText?: unknown;
  readonly summary?: unknown;
  readonly tool?: unknown;
  readonly callId?: unknown;
  readonly args?: unknown;
  readonly visibleOutput?: unknown;
  readonly failureReason?: unknown;
  readonly patchSummary?: unknown;
  readonly commandText?: unknown;
  readonly exitCode?: unknown;
  readonly trigger?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asMuseViewItem(value: unknown): MuseViewItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value["itemId"] !== "string" || typeof value["revision"] !== "number") {
    return null;
  }
  return value as unknown as MuseViewItem;
}

export function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    return readRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}
