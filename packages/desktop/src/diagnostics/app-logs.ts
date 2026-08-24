import log from "electron-log/main";
import { tailFile } from "./tail-file.js";

const APP_LOG_TAIL_LINES = 100;

export interface DesktopAppLogs {
  logPath: string;
  contents: string;
}

export function getDesktopAppLogs(): DesktopAppLogs {
  const logPath = log.transports.file.getFile().path;
  return {
    logPath,
    contents: tailFile(logPath, APP_LOG_TAIL_LINES, { throwOnReadError: true }),
  };
}
