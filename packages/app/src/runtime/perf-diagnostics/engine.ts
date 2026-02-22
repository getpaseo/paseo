import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getNowMs } from "@/utils/perf";
import type {
  PerfDiagnosticBreadcrumb,
  PerfDiagnosticFields,
  PerfDiagnosticsReport,
  PerfDiagnosticsSnapshot,
  RecordPerfDiagnosticMarkOptions,
} from "./types";

const STORAGE_KEY = "paseo:perf-diagnostics:v1";
const LEGACY_STORAGE_KEY = "paseo:js-hang-diagnostics:v1";
const MONITOR_INTERVAL_MS = 100;
const STALL_THRESHOLD_MS = 250;
const SAMPLE_EVERY_N = 40;
const MAX_BREADCRUMBS = 600;
const BREADCRUMBS_PER_REPORT = 220;
const MAX_STORED_REPORTS = 20;

const state = {
  breadcrumbs: [] as PerfDiagnosticBreadcrumb[],
  sampleCursor: 0,
  monitorHandle: null as ReturnType<typeof setInterval> | null,
  monitorLastTickMs: 0,
  monitorScope: null as string | null,
  monitorRefCount: 0,
  loadLogged: false,
  persistQueue: Promise.resolve(),
};

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function sanitizeFieldValue(value: unknown): unknown {
  if (isPrimitive(value)) {
    if (typeof value === "string" && value.length > 180) {
      return `${value.slice(0, 180)}...`;
    }
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (value instanceof Map) {
    return `[map:${value.size}]`;
  }
  if (value instanceof Set) {
    return `[set:${value.size}]`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined) {
    return "[undefined]";
  }
  return "[object]";
}

function sanitizeFields(
  fields?: PerfDiagnosticFields
): PerfDiagnosticFields | undefined {
  if (!fields) {
    return undefined;
  }
  const next: PerfDiagnosticFields = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (count >= 16) {
      next.__truncated__ = true;
      break;
    }
    next[key] = sanitizeFieldValue(value);
    count += 1;
  }
  return next;
}

function shouldEnableDiagnostics(): boolean {
  const globalFlag = (
    globalThis as {
      __PASEO_PERF_DIAGNOSTICS__?: unknown;
      __PASEO_JS_HANG_DIAGNOSTICS__?: unknown;
    }
  ).__PASEO_PERF_DIAGNOSTICS__;
  const legacyFlag = (
    globalThis as {
      __PASEO_PERF_DIAGNOSTICS__?: unknown;
      __PASEO_JS_HANG_DIAGNOSTICS__?: unknown;
    }
  ).__PASEO_JS_HANG_DIAGNOSTICS__;
  if (typeof globalFlag === "boolean") {
    return globalFlag;
  }
  if (typeof legacyFlag === "boolean") {
    return legacyFlag;
  }
  const isDev = Boolean((globalThis as { __DEV__?: boolean }).__DEV__);
  return Platform.OS === "android" || isDev;
}

function shouldSample(): boolean {
  state.sampleCursor += 1;
  if (state.sampleCursor >= SAMPLE_EVERY_N) {
    state.sampleCursor = 0;
    return true;
  }
  return false;
}

function pushBreadcrumb(item: PerfDiagnosticBreadcrumb): void {
  state.breadcrumbs.push(item);
  if (state.breadcrumbs.length > MAX_BREADCRUMBS) {
    state.breadcrumbs.splice(0, state.breadcrumbs.length - MAX_BREADCRUMBS);
  }
}

function safeParseReports(raw: string | null): PerfDiagnosticsReport[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry) => entry && typeof entry === "object"
    ) as PerfDiagnosticsReport[];
  } catch {
    return [];
  }
}

async function readPersistedReports(): Promise<PerfDiagnosticsReport[]> {
  const stored = safeParseReports(await AsyncStorage.getItem(STORAGE_KEY));
  if (stored.length > 0) {
    return stored;
  }
  const legacy = safeParseReports(await AsyncStorage.getItem(LEGACY_STORAGE_KEY));
  if (legacy.length > 0) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(legacy));
    await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  }
  return legacy;
}

async function persistReport(report: PerfDiagnosticsReport): Promise<void> {
  state.persistQueue = state.persistQueue
    .then(async () => {
      const existing = await readPersistedReports();
      existing.push(report);
      if (existing.length > MAX_STORED_REPORTS) {
        existing.splice(0, existing.length - MAX_STORED_REPORTS);
      }
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    })
    .catch((error) => {
      console.warn("[PerfDiagnostics] Failed to persist report", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  await state.persistQueue;
}

function buildReport(
  scope: string,
  atMs: number,
  lagMs: number
): PerfDiagnosticsReport {
  const id = `${Math.round(atMs)}-${Math.floor(Math.random() * 1_000_000)}`;
  const breadcrumbs = state.breadcrumbs.slice(-BREADCRUMBS_PER_REPORT);
  const wallTimeMs = Date.now();
  return {
    id,
    scope,
    atMs,
    wallTimeMs,
    wallTimeIso: new Date(wallTimeMs).toISOString(),
    lagMs,
    platform: Platform.OS,
    breadcrumbs,
  };
}

export function recordPerfDiagnosticMark(
  name: string,
  fields?: PerfDiagnosticFields,
  options?: RecordPerfDiagnosticMarkOptions
): void {
  if (!shouldEnableDiagnostics()) {
    return;
  }
  const force = options?.force === true;
  if (!force && !shouldSample()) {
    return;
  }
  pushBreadcrumb({
    atMs: getNowMs(),
    kind: "mark",
    name,
    fields: sanitizeFields(fields),
  });
}

export function installPerfDiagnosticsMonitor(scope: string): () => void {
  if (!shouldEnableDiagnostics()) {
    return () => {};
  }

  if (state.monitorRefCount === 0) {
    state.monitorScope = scope;
    state.monitorLastTickMs = getNowMs();
    state.monitorHandle = setInterval(() => {
      const nowMs = getNowMs();
      const lagMs = nowMs - state.monitorLastTickMs - MONITOR_INTERVAL_MS;
      if (lagMs >= STALL_THRESHOLD_MS) {
        const report = buildReport(state.monitorScope ?? scope, nowMs, lagMs);
        recordPerfDiagnosticMark(
          "perf.stall_detected",
          {
            scope: report.scope,
            lagMs: Math.round(lagMs),
            reportId: report.id,
            breadcrumbs: report.breadcrumbs.length,
          },
          { force: true }
        );
        console.warn("[PerfDiagnostics] JS stall detected", {
          scope: report.scope,
          lagMs: Math.round(lagMs),
          reportId: report.id,
          breadcrumbs: report.breadcrumbs.length,
        });
        void persistReport(report);
      }
      state.monitorLastTickMs = nowMs;
    }, MONITOR_INTERVAL_MS);
  }

  state.monitorRefCount += 1;

  if (!state.loadLogged) {
    state.loadLogged = true;
    void readPersistedReports()
      .then((reports) => {
        if (reports.length > 0) {
          console.warn("[PerfDiagnostics] Recovered persisted stall reports", {
            count: reports.length,
            latestReportId: reports[reports.length - 1]?.id ?? null,
          });
        }
      })
      .catch(() => undefined);
  }

  return () => {
    state.monitorRefCount = Math.max(0, state.monitorRefCount - 1);
    if (state.monitorRefCount === 0 && state.monitorHandle) {
      clearInterval(state.monitorHandle);
      state.monitorHandle = null;
      state.monitorScope = null;
    }
  };
}

export async function consumePersistedPerfDiagnosticReports(): Promise<
  PerfDiagnosticsReport[]
> {
  const reports = await readPersistedReports();
  await AsyncStorage.removeItem(STORAGE_KEY);
  await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  return reports;
}

export async function peekPersistedPerfDiagnosticReports(): Promise<
  PerfDiagnosticsReport[]
> {
  return readPersistedReports();
}

export function isPerfDiagnosticsEnabled(): boolean {
  return shouldEnableDiagnostics();
}

export function getPerfDiagnosticBreadcrumbs(
  limit = 120
): PerfDiagnosticBreadcrumb[] {
  if (limit <= 0) {
    return [];
  }
  return state.breadcrumbs.slice(-Math.floor(limit));
}

export function getPerfDiagnosticsSnapshot(limit = 120): PerfDiagnosticsSnapshot {
  return {
    enabled: shouldEnableDiagnostics(),
    monitorScope: state.monitorScope,
    breadcrumbCount: state.breadcrumbs.length,
    breadcrumbs: getPerfDiagnosticBreadcrumbs(limit),
  };
}
