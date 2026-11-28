import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export interface SocketOwnerCheckInput {
  clientPort: number;
  serverPort: number;
}

export interface SocketOwnerVerifier {
  (input: SocketOwnerCheckInput): Promise<boolean>;
  dispose?: () => void;
}

export interface WindowsSocketOwnerWorker {
  lookup: (input: SocketOwnerCheckInput) => Promise<boolean>;
  dispose: () => void;
}

export interface OsSocketOwnerVerifierDeps {
  platform?: NodeJS.Platform;
  getCurrentUid?: () => number | null;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  execFile?: (
    command: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean },
  ) => Promise<{ stdout: string }>;
  createWindowsWorker?: () => WindowsSocketOwnerWorker;
}

const LINUX_LOOPBACK_IPV4_HEX = "0100007F";
const LINUX_LOOPBACK_IPV4_MAPPED_IPV6_HEX = "0000000000000000FFFF00000100007F";
const LOOKUP_TIMEOUT_MS = 3_000;
const WINDOWS_WORKER_SCRIPT = [
  "$selfSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;",
  "$cache = @{};",
  "while (($line = [Console]::In.ReadLine()) -ne $null) {",
  "  $parts = $line.Trim().Split(' ');",
  "  if ($parts.Length -ne 2) { [Console]::Out.WriteLine('0'); continue }",
  "  $cp = [int]$parts[0]; $sp = [int]$parts[1];",
  "  $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $cp -RemoteAddress 127.0.0.1 -RemotePort $sp -ErrorAction SilentlyContinue | Select-Object -First 1;",
  "  if (-not $conn) { [Console]::Out.WriteLine('0'); continue }",
  "  $pidKey = [int]$conn.OwningProcess;",
  "  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();",
  "  $entry = $cache[$pidKey];",
  "  if ($entry -and ($now - $entry.ts) -lt 10000) {",
  "    [Console]::Out.WriteLine($(if ($entry.ok) { '1' } else { '0' }));",
  "    continue",
  "  }",
  "  $ok = $false;",
  "  try {",
  '    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pidKey" -ErrorAction SilentlyContinue;',
  "    if ($proc) {",
  "      $sid = (Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid).Sid;",
  "      $ok = ($sid -eq $selfSid);",
  "    }",
  "  } catch { $ok = $false }",
  "  $cache[$pidKey] = @{ ok = $ok; ts = $now };",
  "  [Console]::Out.WriteLine($(if ($ok) { '1' } else { '0' }));",
  "}",
].join(" ");

function formatHexPort(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, "0");
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function findLinuxLoopbackSocketUid(
  procNetTcpContent: string,
  clientPort: number,
  serverPort: number,
): number | null {
  if (!isValidPort(clientPort) || !isValidPort(serverPort)) {
    return null;
  }
  const clientHexPort = formatHexPort(clientPort);
  const serverHexPort = formatHexPort(serverPort);
  const targetLocalV4 = `${LINUX_LOOPBACK_IPV4_HEX}:${clientHexPort}`;
  const targetRemoteV4 = `${LINUX_LOOPBACK_IPV4_HEX}:${serverHexPort}`;
  const targetLocalV6 = `${LINUX_LOOPBACK_IPV4_MAPPED_IPV6_HEX}:${clientHexPort}`;
  const targetRemoteV6 = `${LINUX_LOOPBACK_IPV4_MAPPED_IPV6_HEX}:${serverHexPort}`;

  const lines = procNetTcpContent.split(/\r?\n/u);
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/u);
    if (fields.length < 8) continue;
    const localAddr = fields[1]?.toUpperCase();
    const remoteAddr = fields[2]?.toUpperCase();
    if (
      (localAddr === targetLocalV4 && remoteAddr === targetRemoteV4) ||
      (localAddr === targetLocalV6 && remoteAddr === targetRemoteV6)
    ) {
      const uid = Number.parseInt(fields[7] ?? "", 10);
      return Number.isInteger(uid) && uid >= 0 ? uid : null;
    }
  }
  return null;
}

export function findDarwinLoopbackSocketUid(
  lsofOutput: string,
  clientPort: number,
  serverPort: number,
): number | null {
  if (!isValidPort(clientPort) || !isValidPort(serverPort)) {
    return null;
  }
  const expectedName = `127.0.0.1:${clientPort}->127.0.0.1:${serverPort}`;
  let currentUid: number | null = null;
  for (const rawLine of lsofOutput.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const prefix = line[0];
    const value = line.slice(1);
    if (prefix === "p") {
      currentUid = null;
    } else if (prefix === "u") {
      const parsed = Number.parseInt(value, 10);
      currentUid = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    } else if (prefix === "n" && value === expectedName) {
      return currentUid;
    }
  }
  return null;
}

export function parseWindowsLoopbackSocketOwner(output: string): string | null {
  const sid = output.trim();
  return /^S-1-\d+(?:-\d+)+$/u.test(sid) ? sid : null;
}

/**
 * Keeps a single warm PowerShell worker on Windows so parallel browser
 * connections do not each pay PowerShell startup + NetTCPIP/WMI cold boot.
 * Serializes line-delimited `<clientPort> <serverPort>` lookups and resets
 * cleanly on timeout or process exit.
 */
function createPersistentWindowsPowerShellWorker(): WindowsSocketOwnerWorker {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdoutBuffer = "";
  let disposed = false;

  interface QueuedLookup {
    input: SocketOwnerCheckInput;
    resolve: (allowed: boolean) => void;
    timer: ReturnType<typeof setTimeout> | null;
  }

  let active: QueuedLookup | null = null;
  const queue: QueuedLookup[] = [];

  const failActiveAndReset = () => {
    const current = active;
    active = null;
    if (current) {
      if (current.timer) clearTimeout(current.timer);
      current.resolve(false);
    }
    const oldChild = child;
    child = null;
    stdoutBuffer = "";
    if (oldChild && !oldChild.killed) {
      try {
        oldChild.kill();
      } catch {
        // ignore
      }
    }
    if (!disposed) {
      pumpQueue();
    }
  };

  const ensureChild = (): ChildProcessWithoutNullStreams | null => {
    if (disposed) return null;
    if (child && !child.killed && child.exitCode === null) {
      return child;
    }
    const proc = nodeSpawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_WORKER_SCRIPT],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child = proc;
    stdoutBuffer = "";

    proc.stdin.on("error", () => {
      if (child === proc) failActiveAndReset();
    });
    proc.stdout.on("data", (chunk: Buffer | string) => {
      if (child !== proc) return;
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const current = active;
        active = null;
        if (current) {
          if (current.timer) clearTimeout(current.timer);
          current.resolve(line === "1");
        }
        pumpQueue();
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    proc.on("error", () => {
      if (child === proc) failActiveAndReset();
    });
    proc.on("exit", () => {
      if (child === proc) failActiveAndReset();
    });
    return proc;
  };

  const pumpQueue = () => {
    if (disposed || active || queue.length === 0) return;
    const next = queue.shift()!;
    const proc = ensureChild();
    if (!proc) {
      next.resolve(false);
      return;
    }
    active = next;
    next.timer = setTimeout(() => {
      if (active === next) {
        failActiveAndReset();
      }
    }, LOOKUP_TIMEOUT_MS);
    next.timer.unref?.();

    try {
      proc.stdin.write(`${next.input.clientPort} ${next.input.serverPort}\n`);
    } catch {
      failActiveAndReset();
    }
  };

  return {
    lookup: (input) =>
      new Promise<boolean>((resolve) => {
        if (disposed) {
          resolve(false);
          return;
        }
        queue.push({ input, resolve, timer: null });
        pumpQueue();
      }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const queued of queue.splice(0)) {
        if (queued.timer) clearTimeout(queued.timer);
        queued.resolve(false);
      }
      failActiveAndReset();
    },
  };
}

export function createOsSocketOwnerVerifier(
  deps: OsSocketOwnerVerifierDeps = {},
): SocketOwnerVerifier {
  const platform = deps.platform ?? process.platform;
  const getCurrentUid =
    deps.getCurrentUid ?? (() => (typeof process.getuid === "function" ? process.getuid() : null));
  const readFile = deps.readFile ?? ((filePath, encoding) => nodeReadFile(filePath, encoding));
  const execFile =
    deps.execFile ??
    (async (command, args, options) => {
      const result = await execFileAsync(command, args, {
        encoding: "utf8",
        timeout: options?.timeout ?? LOOKUP_TIMEOUT_MS,
        windowsHide: options?.windowsHide ?? true,
      });
      return { stdout: result.stdout };
    });

  let windowsWorker: WindowsSocketOwnerWorker | null = null;
  const getWindowsWorker = (): WindowsSocketOwnerWorker => {
    if (!windowsWorker) {
      windowsWorker = (deps.createWindowsWorker ?? createPersistentWindowsPowerShellWorker)();
    }
    return windowsWorker;
  };

  const verify: SocketOwnerVerifier = async ({
    clientPort,
    serverPort,
  }: SocketOwnerCheckInput): Promise<boolean> => {
    if (!isValidPort(clientPort) || !isValidPort(serverPort)) {
      return false;
    }

    if (platform === "linux") {
      const expectedUid = getCurrentUid();
      if (expectedUid === null) return false;
      try {
        const tcpContent = await readFile("/proc/net/tcp", "utf8");
        const uid = findLinuxLoopbackSocketUid(tcpContent, clientPort, serverPort);
        if (uid !== null) {
          return uid === expectedUid;
        }
        const tcp6Content = await readFile("/proc/net/tcp6", "utf8").catch(() => "");
        const uid6 = findLinuxLoopbackSocketUid(tcp6Content, clientPort, serverPort);
        return uid6 !== null && uid6 === expectedUid;
      } catch {
        return false;
      }
    }

    if (platform === "darwin") {
      const expectedUid = getCurrentUid();
      if (expectedUid === null) return false;
      try {
        const { stdout } = await execFile(
          "lsof",
          ["-nP", "-F", "pun", `-iTCP@127.0.0.1:${clientPort}`],
          { timeout: LOOKUP_TIMEOUT_MS },
        );
        const uid = findDarwinLoopbackSocketUid(stdout, clientPort, serverPort);
        return uid !== null && uid === expectedUid;
      } catch {
        return false;
      }
    }

    if (platform === "win32") {
      try {
        return await getWindowsWorker().lookup({ clientPort, serverPort });
      } catch {
        return false;
      }
    }

    return false;
  };

  verify.dispose = () => {
    windowsWorker?.dispose();
    windowsWorker = null;
  };

  return verify;
}
