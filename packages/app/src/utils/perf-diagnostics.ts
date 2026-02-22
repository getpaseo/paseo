// Compatibility shim while callers move to `@/runtime/perf-diagnostics`.
// Keep this file side-effect free.
export {
  consumePersistedPerfDiagnosticReports,
  getPerfDiagnosticBreadcrumbs,
  getPerfDiagnosticsSnapshot,
  installPerfDiagnosticsMonitor,
  isPerfDiagnosticsEnabled,
  peekPersistedPerfDiagnosticReports,
  recordPerfDiagnosticMark,
} from "@/runtime/perf-diagnostics";

export type {
  PerfDiagnosticBreadcrumb,
  PerfDiagnosticFields,
  PerfDiagnosticsReport,
  PerfDiagnosticsSnapshot,
  PerfDiagnosticsReporter,
  RecordPerfDiagnosticMarkOptions,
} from "@/runtime/perf-diagnostics";
