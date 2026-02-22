import { useEffect, useMemo, type ReactNode } from "react";
import { installPerfDiagnosticsDebugTools } from "./debug-tools";
import { PerfDiagnosticsContext } from "./perf-diagnostics-context";
import { getPerfDiagnosticsReporter } from "./reporter";

interface PerfDiagnosticsProviderProps {
  children: ReactNode;
  scope?: string;
}

export function PerfDiagnosticsProvider({
  children,
  scope = "root_layout",
}: PerfDiagnosticsProviderProps) {
  const reporter = useMemo(() => getPerfDiagnosticsReporter(), []);

  useEffect(() => {
    if (!reporter.isEnabled()) {
      return;
    }

    const removeDebugTools = installPerfDiagnosticsDebugTools();
    const stopMonitor = reporter.installMonitor(scope);

    void reporter
      .peekReports()
      .then((reports) => {
        if (reports.length === 0) {
          return;
        }
        const latest = reports[reports.length - 1];
        console.warn("[PerfDiagnostics] Loaded persisted stall reports", {
          count: reports.length,
          latestReportId: latest?.id ?? null,
          latestWallTime: latest?.wallTimeIso ?? null,
          latestLagMs: latest ? Math.round(latest.lagMs) : null,
          latestBreadcrumbs: latest?.breadcrumbs.length ?? null,
        });
      })
      .catch(() => undefined);

    return () => {
      removeDebugTools();
      stopMonitor();
    };
  }, [scope, reporter]);

  return (
    <PerfDiagnosticsContext.Provider value={reporter}>
      {children}
    </PerfDiagnosticsContext.Provider>
  );
}
