const getIsDevEnvironment = (): boolean => {
  const globalDev = (globalThis as { __DEV__?: boolean } | undefined)?.__DEV__;
  if (typeof globalDev === "boolean") {
    return globalDev;
  }
  if (typeof process !== "undefined" && process.env?.NODE_ENV) {
    return process.env.NODE_ENV !== "production";
  }
  return false;
};

const shouldDisablePerfLogging =
  typeof process !== "undefined" && process.env?.EXPO_PUBLIC_DISABLE_PERF_LOGGING === "1";
const shouldForcePerfLogging =
  typeof process !== "undefined" && process.env?.EXPO_PUBLIC_ENABLE_PERF_LOGGING === "1";

const PERF_LOGGING_ENABLED =
  (shouldForcePerfLogging || getIsDevEnvironment()) && !shouldDisablePerfLogging;

export const isPerfLoggingEnabled = (): boolean => PERF_LOGGING_ENABLED;

export const perfLog = (tag: string, details: Record<string, unknown>): void => {
  if (!PERF_LOGGING_ENABLED) {
    return;
  }
  console.info(tag, details);
};

export const getNowMs = (): number => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

export interface PayloadMetrics {
  approxBytes: number;
  fieldCount: number;
}

const MEASUREMENT_DEPTH = 2;

export const measurePayload = (payload: unknown): PayloadMetrics => {
  if (!payload || typeof payload !== "object") {
    return {
      approxBytes: 0,
      fieldCount: 0,
    };
  }

  const fieldCount = Object.keys(payload as Record<string, unknown>).length;
  const approxBytes = estimateSize(payload, MEASUREMENT_DEPTH, new WeakSet());

  return {
    approxBytes,
    fieldCount,
  };
};

const estimateSize = (value: unknown, depth: number, seen: WeakSet<object>): number => {
  if (depth <= 0 || value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "string") {
    return value.length;
  }

  if (typeof value === "number") {
    return 8;
  }

  if (typeof value === "boolean") {
    return 4;
  }

  if (typeof value === "bigint") {
    return value.toString().length;
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return 0;
  }

  if (typeof value !== "object") {
    return 0;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return 0;
  }
  seen.add(objectValue);

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateSize(item, depth - 1, seen), 0);
  }

  if (value instanceof Map) {
    let total = 0;
    for (const [mapKey, mapValue] of value.entries()) {
      total += estimateSize(mapKey, depth - 1, seen);
      total += estimateSize(mapValue, depth - 1, seen);
    }
    return total;
  }

  if (value instanceof Set) {
    let total = 0;
    for (const setValue of value.values()) {
      total += estimateSize(setValue, depth - 1, seen);
    }
    return total;
  }

  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    total += key.length;
    total += estimateSize(child, depth - 1, seen);
  }
  return total;
};
