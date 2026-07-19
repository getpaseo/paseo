import {
  getDesktopAppLogs,
  getDesktopDaemonLogs,
  getDesktopDaemonStatus,
  type DesktopAppLogs,
  type DesktopDaemonLogs,
  type DesktopDaemonStatus,
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
}

const DEFAULT_DESKTOP_DIAGNOSTIC_SOURCES: DesktopDiagnosticSources = {
  getStatus: getDesktopDaemonStatus,
  getDaemonLogs: getDesktopDaemonLogs,
  getAppLogs: getDesktopAppLogs,
};

export async function collectDesktopDiagnosticSections(
  sources: DesktopDiagnosticSources = DEFAULT_DESKTOP_DIAGNOSTIC_SOURCES,
): Promise<DesktopDiagnosticCollectionResult> {
  const sections: string[] = [];
  let failed = false;

  const [daemonResult, appLogsResult] = await Promise.allSettled([
    Promise.all([sources.getStatus(), sources.getDaemonLogs()]),
    sources.getAppLogs(),
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

  return {
    status: failed ? "failed" : "done",
    sections,
  };
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
