import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface NodePathFromPidResult {
  nodePath: string | null;
  error?: string;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveNodePathFromPidUnix(pid: number): NodePathFromPidResult {
  const result = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { nodePath: null, error: `ps failed: ${normalizeError(result.error)}` };
  }

  if ((result.status ?? 1) !== 0) {
    const details = result.stderr?.trim();
    return {
      nodePath: null,
      error: details ? `ps failed: ${details}` : `ps exited with code ${result.status ?? 1}`,
    };
  }

  const resolved = result.stdout.trim();
  return resolved
    ? { nodePath: resolved }
    : { nodePath: null, error: "ps returned an empty command path" };
}

function runProcessProbe(
  command: string,
  args: string[],
): {
  resolved: string | null;
  error?: string;
} {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    return { resolved: null, error: `${command} failed: ${normalizeError(result.error)}` };
  }

  if ((result.status ?? 1) !== 0) {
    const details = result.stderr?.trim();
    return {
      resolved: null,
      error: details
        ? `${command} failed: ${details}`
        : `${command} exited with code ${result.status ?? 1}`,
    };
  }

  const resolved = result.stdout.trim();
  return resolved
    ? { resolved }
    : { resolved: null, error: `${command} returned no executable path` };
}

function resolveNodePathFromPidWindows(pid: number): NodePathFromPidResult {
  const probes: Array<{
    label: string;
    command: string;
    args: string[];
    parseValue?: (stdout: string) => string | null;
  }> = [
    {
      label: "powershell-cim",
      command: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").ExecutablePath`,
      ],
    },
    {
      label: "powershell-process",
      command: "powershell",
      args: ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Path`],
    },
    {
      label: "wmic",
      command: "wmic",
      args: ["process", "where", `ProcessId=${pid}`, "get", "ExecutablePath", "/VALUE"],
      parseValue: (stdout) => {
        const match = stdout.match(/ExecutablePath=(.+)/);
        return match?.[1]?.trim() ?? null;
      },
    },
  ];

  const errors: string[] = [];
  for (const probe of probes) {
    const result = runProcessProbe(probe.command, probe.args);
    if (result.resolved) {
      const resolved = probe.parseValue ? probe.parseValue(result.resolved) : result.resolved;
      if (resolved) {
        return { nodePath: resolved };
      }
      errors.push(`${probe.label} returned no executable path`);
      continue;
    }
    if (result.error) {
      errors.push(`${probe.label}: ${result.error}`);
    }
  }

  return {
    nodePath: null,
    error: errors.join("; ") || "could not resolve executable path from PID",
  };
}

export function resolveNodePathFromPid(pid: number): NodePathFromPidResult {
  return platform() === "win32"
    ? resolveNodePathFromPidWindows(pid)
    : resolveNodePathFromPidUnix(pid);
}
