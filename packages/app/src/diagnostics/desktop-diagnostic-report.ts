import {
  getDesktopAppLogs,
  getDesktopDaemonLogs,
  getDesktopDaemonStatus,
  getDesktopUpdaterDiagnostics,
  type DesktopAppLogs,
  type DesktopDaemonLogs,
  type DesktopDaemonStatus,
  type DesktopUpdaterDiagnosticFile,
  type DesktopUpdaterDiagnostics,
} from "@/desktop/daemon/desktop-daemon";
import { formatDiagnosticSection } from "./app-diagnostic-report";

type DesktopDiagnosticStatus = "done" | "failed";

export interface DesktopDiagnosticCollectionResult {
  sections: string[];
  status: DesktopDiagnosticStatus;
}

export interface DesktopDiagnosticSources {
  getStatus: () => Promise<DesktopDaemonStatus>;
  getDaemonLogs: () => Promise<DesktopDaemonLogs>;
  getAppLogs: () => Promise<DesktopAppLogs>;
  getUpdaterDiagnostics: () => Promise<DesktopUpdaterDiagnostics>;
}

const DEFAULT_DESKTOP_DIAGNOSTIC_SOURCES: DesktopDiagnosticSources = {
  getStatus: getDesktopDaemonStatus,
  getDaemonLogs: getDesktopDaemonLogs,
  getAppLogs: getDesktopAppLogs,
  getUpdaterDiagnostics: getDesktopUpdaterDiagnostics,
};

export async function collectDesktopDiagnosticSections(
  sources: DesktopDiagnosticSources = DEFAULT_DESKTOP_DIAGNOSTIC_SOURCES,
): Promise<DesktopDiagnosticCollectionResult> {
  const sections: string[] = [];
  let failed = false;

  const [daemonResult, appLogsResult, updaterResult] = await Promise.allSettled([
    Promise.all([sources.getStatus(), sources.getDaemonLogs()]),
    sources.getAppLogs(),
    sources.getUpdaterDiagnostics(),
  ]);

  if (daemonResult.status === "fulfilled") {
    const [status, daemonLogs] = daemonResult.value;
    const appLogs = appLogsResult.status === "fulfilled" ? appLogsResult.value : null;
    sections.unshift(...formatDesktopDaemonSections({ status, daemonLogs, appLogs }));
  } else {
    failed = true;
    sections.unshift(
      formatDiagnosticSection("Desktop", [
        { label: "Error", value: toMessage(daemonResult.reason) },
      ]),
    );
  }

  if (appLogsResult.status === "fulfilled") {
    sections.push(formatLogTailSection("Desktop app log tail", appLogsResult.value.contents));
  } else {
    failed = true;
    sections.push(
      formatDiagnosticSection("Desktop app log tail", [
        { label: "Error", value: toMessage(appLogsResult.reason) },
      ]),
    );
  }

  if (updaterResult.status === "fulfilled") {
    sections.push(...formatDesktopUpdaterSections(updaterResult.value));
  } else {
    failed = true;
    sections.push(
      formatDiagnosticSection("Desktop updater", [
        { label: "Error", value: toMessage(updaterResult.reason) },
      ]),
    );
  }

  return {
    status: failed ? "failed" : "done",
    sections,
  };
}

function formatDesktopUpdaterSections(diagnostics: DesktopUpdaterDiagnostics): string[] {
  const updaterDetails = [
    { label: "Platform", value: diagnostics.platform },
    { label: "Current version", value: diagnostics.currentVersion },
    { label: "Target version", value: diagnostics.targetVersion ?? "unknown" },
    { label: "ShipIt directory", value: diagnostics.shipItDirectory ?? "not applicable" },
  ];
  if (diagnostics.targetVersionError) {
    updaterDetails.push({ label: "Target version error", value: diagnostics.targetVersionError });
  }
  const sections = [formatDiagnosticSection("Desktop updater", updaterDetails)];

  if (diagnostics.platform !== "darwin") return sections;

  sections.push(
    formatUpdaterFileSection("ShipItState.plist", diagnostics.state),
    formatUpdaterFileSection("ShipIt stdout log tail", diagnostics.stdout),
    formatUpdaterFileSection("ShipIt stderr log tail", diagnostics.stderr),
  );
  return sections;
}

function formatUpdaterFileSection(
  title: string,
  file: DesktopUpdaterDiagnosticFile | null,
): string {
  if (!file) {
    return formatDiagnosticSection(title, [{ label: "Status", value: "unavailable" }]);
  }

  const header = formatDiagnosticSection(title, [
    { label: "Path", value: file.path || "unknown" },
    { label: "Modified", value: file.modifiedAt ?? "unknown" },
  ]);
  if (file.error) return `${header}\n  Error: ${file.error}`;
  if (!file.exists) return `${header}\n  File not found`;
  if (!file.contents) return `${header}\n  No contents found`;
  return `${header}\n${indentBlock(file.contents)}`;
}

function formatDesktopDaemonSections(input: {
  status: DesktopDaemonStatus;
  daemonLogs: DesktopDaemonLogs;
  appLogs: DesktopAppLogs | null;
}): string[] {
  const { status, daemonLogs, appLogs } = input;
  return [
    formatDiagnosticSection("Desktop", [
      { label: "Daemon status", value: status.status },
      { label: "Desktop managed", value: String(status.desktopManaged) },
      { label: "Daemon PID", value: status.pid === null ? "none" : String(status.pid) },
      { label: "Daemon version", value: status.version ?? "unknown" },
      { label: "Daemon home", value: status.home || "unknown" },
      { label: "Log path", value: daemonLogs.logPath || "unknown" },
      { label: "App log path", value: appLogs?.logPath || "unavailable" },
      { label: "Error", value: status.error ?? "none" },
    ]),
    formatLogTailSection("Desktop daemon log tail", daemonLogs.contents),
  ];
}

function formatLogTailSection(title: string, contents: string): string {
  return [title, contents ? indentBlock(contents) : "  No log lines found"].join("\n");
}

function indentBlock(value: string): string {
  return value
    .split("\n")
    .filter(Boolean)
    .map((line) => `  ${line}`)
    .join("\n");
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
