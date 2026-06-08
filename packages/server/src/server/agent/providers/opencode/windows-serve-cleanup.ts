import { execFile } from "node:child_process";
import type { Logger } from "pino";

const WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS = 5_000;

export async function cleanupWindowsOpenCodeServeProcessesByPort(
  port: number,
  logger: Logger,
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const stdout = await runPowerShell(buildCleanupScript(port));
  const killedProcesses = stdout.trim();
  if (killedProcesses) {
    logger.warn({ port, killedProcesses }, "Cleaned up lingering OpenCode serve processes");
  }
}

function buildCleanupScript(port: number): string {
  return `
$ErrorActionPreference = "SilentlyContinue"
$port = ${port}
$portPattern = "(^|\\s)--port(\\s+|=)$port(\\s|$)"
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -match "(?i)opencode(\\.cmd|\\.exe)?" -and
  $_.CommandLine -match "(^|\\s)serve(\\s|$)" -and
  $_.CommandLine -match $portPattern
}
$processes | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    ProcessId = $_.ProcessId
    Name = $_.Name
    CommandLine = $_.CommandLine
  }
} | ConvertTo-Json -Compress
`;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        timeout: WINDOWS_PROCESS_CLEANUP_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
