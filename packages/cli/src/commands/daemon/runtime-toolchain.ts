import { platform } from "node:os";
import { execCommand } from "@getpaseo/server";

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

async function resolveNodePathFromPidUnix(pid: number): Promise<NodePathFromPidResult> {
  try {
    const { stdout } = await execCommand("ps", ["-o", "comm=", "-p", String(pid)]);
    const resolved = stdout.trim();
    return resolved
      ? { nodePath: resolved }
      : { nodePath: null, error: "ps returned an empty command path" };
  } catch (error) {
    return { nodePath: null, error: `ps failed: ${normalizeError(error)}` };
  }
}

async function runProcessProbe(
  command: string,
  args: string[],
): Promise<{
  resolved: string | null;
  error?: string;
}> {
  try {
    const { stdout } = await execCommand(command, args);
    const resolved = stdout.trim();
    return resolved
      ? { resolved }
      : { resolved: null, error: `${command} returned no executable path` };
  } catch (error) {
    return { resolved: null, error: `${command} failed: ${normalizeError(error)}` };
  }
}

async function resolveNodePathFromPidWindows(pid: number): Promise<NodePathFromPidResult> {
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

  async function tryProbe(index: number): Promise<NodePathFromPidResult> {
    if (index >= probes.length) {
      return {
        nodePath: null,
        error: errors.join("; ") || "could not resolve executable path from PID",
      };
    }
    const probe = probes[index];
    const result = await runProcessProbe(probe.command, probe.args);
    if (result.resolved) {
      const resolved = probe.parseValue ? probe.parseValue(result.resolved) : result.resolved;
      if (resolved) return { nodePath: resolved };
      errors.push(`${probe.label} returned no executable path`);
    } else if (result.error) {
      errors.push(`${probe.label}: ${result.error}`);
    }
    return tryProbe(index + 1);
  }

  return tryProbe(0);
}

export async function resolveNodePathFromPid(pid: number): Promise<NodePathFromPidResult> {
  return platform() === "win32"
    ? await resolveNodePathFromPidWindows(pid)
    : await resolveNodePathFromPidUnix(pid);
}
