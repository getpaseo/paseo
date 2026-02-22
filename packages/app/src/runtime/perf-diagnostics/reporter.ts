import {
  consumePersistedPerfDiagnosticReports,
  getPerfDiagnosticsSnapshot,
  installPerfDiagnosticsMonitor,
  isPerfDiagnosticsEnabled,
  peekPersistedPerfDiagnosticReports,
  recordPerfDiagnosticMark,
} from "./engine";
import type { PerfDiagnosticsReporter } from "./types";

const reporter: PerfDiagnosticsReporter = {
  mark: recordPerfDiagnosticMark,
  installMonitor: installPerfDiagnosticsMonitor,
  consumeReports: consumePersistedPerfDiagnosticReports,
  peekReports: peekPersistedPerfDiagnosticReports,
  isEnabled: isPerfDiagnosticsEnabled,
  getSnapshot: getPerfDiagnosticsSnapshot,
};

export function getPerfDiagnosticsReporter(): PerfDiagnosticsReporter {
  return reporter;
}
