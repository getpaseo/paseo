import {
  consumePersistedPerfDiagnosticReports,
  getPerfDiagnosticsSnapshot,
  isPerfDiagnosticsEnabled,
  peekPersistedPerfDiagnosticReports,
} from "./engine";

export function installPerfDiagnosticsDebugTools(): () => void {
  if (!isPerfDiagnosticsEnabled()) {
    return () => {};
  }

  (
    globalThis as {
      __PASEO_PERF_DIAGNOSTICS_DEBUG__?: {
        snapshot: (limit?: number) => ReturnType<typeof getPerfDiagnosticsSnapshot>;
        consumeReports: () => Promise<
          Awaited<ReturnType<typeof consumePersistedPerfDiagnosticReports>>
        >;
        peekReports: () => Promise<
          Awaited<ReturnType<typeof peekPersistedPerfDiagnosticReports>>
        >;
      };
    }
  ).__PASEO_PERF_DIAGNOSTICS_DEBUG__ = {
    snapshot: (limit?: number) => getPerfDiagnosticsSnapshot(limit ?? 120),
    consumeReports: () => consumePersistedPerfDiagnosticReports(),
    peekReports: () => peekPersistedPerfDiagnosticReports(),
  };

  return () => {
    (
      globalThis as {
        __PASEO_PERF_DIAGNOSTICS_DEBUG__?: unknown;
      }
    ).__PASEO_PERF_DIAGNOSTICS_DEBUG__ = undefined;
  };
}
