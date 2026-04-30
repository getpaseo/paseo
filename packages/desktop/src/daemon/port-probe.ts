import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 1500;

export type PortProbeResult =
  | { kind: "free" }
  | {
      kind: "hubcode";
      serverId: string | null;
      version: string | null;
      hostname: string | null;
      listen: string | null;
      pid: number | null;
    }
  | {
      kind: "foreign";
      pid: number | null;
      processName: string | null;
    };

interface ServerStatusResponse {
  status?: string;
  serverId?: string;
  hostname?: string;
  version?: string;
  listen?: string;
}

export async function probePort(port: number): Promise<PortProbeResult> {
  const status = await fetchDaemonStatus(port);

  if (status?.status === "server_info") {
    const pid = await findPidOnPort(port);
    return {
      kind: "hubcode",
      serverId: typeof status.serverId === "string" ? status.serverId : null,
      version: typeof status.version === "string" ? status.version : null,
      hostname: typeof status.hostname === "string" ? status.hostname : null,
      listen: typeof status.listen === "string" ? status.listen : null,
      pid,
    };
  }

  // No HTTP response (or response is something else). Check if the port is
  // actually held by *some* process; if so, it's a foreign occupant.
  const pid = await findPidOnPort(port);
  if (pid !== null) {
    const processName = await getProcessName(pid);
    return { kind: "foreign", pid, processName };
  }

  return { kind: "free" };
}

async function fetchDaemonStatus(port: number): Promise<ServerStatusResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (body && typeof body === "object") {
      return body as ServerStatusResponse;
    }
    return null;
  } catch {
    // Connection refused, timeout, abort, JSON error — all map to "no Hubcode
    // daemon answering". Caller falls back to PID-on-port detection.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function findPidOnPort(port: number): Promise<number | null> {
  if (process.platform === "win32") {
    return findPidOnPortWindows(port);
  }
  return findPidOnPortUnix(port);
}

async function findPidOnPortUnix(port: number): Promise<number | null> {
  try {
    // -t = terse (PIDs only), -P = no port name resolution, -n = no DNS,
    // -sTCP:LISTEN = listening sockets only. -i :PORT scopes to that port.
    const { stdout } = await execFileAsync(
      "lsof",
      ["-tP", "-n", "-iTCP:" + String(port), "-sTCP:LISTEN"],
      { timeout: 2000 },
    );
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d+$/.test(line));
    return first ? Number.parseInt(first, 10) : null;
  } catch {
    return null;
  }
}

async function findPidOnPortWindows(port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { timeout: 3000 });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      // Format: "  TCP    127.0.0.1:6767    0.0.0.0:0    LISTENING    12345"
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const pidStr = parts[parts.length - 1];
      if (!local || !pidStr) continue;
      if (local.endsWith(":" + String(port))) {
        const pid = Number.parseInt(pidStr, 10);
        if (Number.isFinite(pid)) return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getProcessName(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"],
        { timeout: 2000 },
      );
      // CSV row: "image.exe","12345","Console","1","12,345 K"
      const match = stdout.trim().match(/^"([^"]+)"/m);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
