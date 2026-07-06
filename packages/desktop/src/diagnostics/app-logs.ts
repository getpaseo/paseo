import { readFileSync } from "node:fs";
import log from "electron-log/main";

const APP_LOG_TAIL_LINES = 100;

export interface DesktopAppLogs {
  logPath: string;
  contents: string;
}

export function getDesktopAppLogs(): DesktopAppLogs {
  const logPath = log.transports.file.getFile().path;
  return {
    logPath,
    contents: tailFile(logPath, APP_LOG_TAIL_LINES),
  };
}

function tailFile(filePath: string, lines: number): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}
