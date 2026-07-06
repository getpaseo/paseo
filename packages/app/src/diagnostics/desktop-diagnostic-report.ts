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

export async function collectDesktopDiagnosticSections(): Promise<DesktopDiagnosticCollectionResult> {
  return collectDesktopDiagnosticSectionsFromSources({
    getStatus: getDesktopDaemonStatus,
    getDaemonLogs: getDesktopDaemonLogs,
    getAppLogs: getDesktopAppLogs,
  });
}

export async function collectDesktopDiagnosticSectionsFromSources(
  sources: DesktopDiagnosticSources,
): Promise<DesktopDiagnosticCollectionResult> {
  const sections: string[] = [];
  let failed = false;
  let appLogs: DesktopAppLogs | null = null;

  try {
    appLogs = await sources.getAppLogs();
  } catch (error) {
    failed = true;
    sections.push(
      formatDiagnosticSection("Desktop app log tail", [
        { label: "Error", value: toMessage(error) },
      ]),
    );
  }

  try {
    const [status, daemonLogs] = await Promise.all([sources.getStatus(), sources.getDaemonLogs()]);
    sections.unshift(...formatDesktopDaemonSections({ status, daemonLogs, appLogs }));
  } catch (error) {
    failed = true;
    sections.unshift(
      formatDiagnosticSection("Desktop", [{ label: "Error", value: toMessage(error) }]),
    );
  }

  if (appLogs) {
    sections.push(formatLogTailSection("Desktop app log tail", appLogs.contents));
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
