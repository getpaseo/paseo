export type PerfDiagnosticFields = Record<string, unknown>;

export interface PerfDiagnosticBreadcrumb {
  atMs: number;
  kind: "mark" | "span";
  name: string;
  durationMs?: number;
  fields?: PerfDiagnosticFields;
}

export interface PerfDiagnosticsReport {
  id: string;
  scope: string;
  atMs: number;
  wallTimeMs: number;
  wallTimeIso: string;
  lagMs: number;
  platform: string;
  breadcrumbs: PerfDiagnosticBreadcrumb[];
}

export interface RecordPerfDiagnosticMarkOptions {
  force?: boolean;
}

export interface PerfDiagnosticsSnapshot {
  enabled: boolean;
  monitorScope: string | null;
  breadcrumbCount: number;
  breadcrumbs: PerfDiagnosticBreadcrumb[];
}

export interface PerfDiagnosticsReporter {
  mark: (
    name: string,
    fields?: PerfDiagnosticFields,
    options?: RecordPerfDiagnosticMarkOptions
  ) => void;
  installMonitor: (scope: string) => () => void;
  consumeReports: () => Promise<PerfDiagnosticsReport[]>;
  peekReports: () => Promise<PerfDiagnosticsReport[]>;
  isEnabled: () => boolean;
  getSnapshot: (limit?: number) => PerfDiagnosticsSnapshot;
}
