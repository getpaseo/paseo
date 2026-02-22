import { createContext } from "react";
import type { PerfDiagnosticsReporter, PerfDiagnosticsSnapshot } from "./types";

const EMPTY_SNAPSHOT: PerfDiagnosticsSnapshot = {
  enabled: false,
  monitorScope: null,
  breadcrumbCount: 0,
  breadcrumbs: [],
};

const NOOP_REPORTER: PerfDiagnosticsReporter = {
  mark: () => {},
  installMonitor: () => () => {},
  consumeReports: async () => [],
  peekReports: async () => [],
  isEnabled: () => false,
  getSnapshot: () => EMPTY_SNAPSHOT,
};

export const PerfDiagnosticsContext =
  createContext<PerfDiagnosticsReporter>(NOOP_REPORTER);
