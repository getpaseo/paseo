import { useContext } from "react";
import { PerfDiagnosticsContext } from "./perf-diagnostics-context";
import type { PerfDiagnosticsReporter } from "./types";

export function usePerfDiagnostics(): PerfDiagnosticsReporter {
  return useContext(PerfDiagnosticsContext);
}
