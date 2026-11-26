import { execFile as nodeExecFile } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export interface SocketOwnerCheckInput {
  clientPort: number;
  serverPort: number;
}

export type SocketOwnerVerifier = (input: SocketOwnerCheckInput) => Promise<boolean>;

export interface OsSocketOwnerVerifierDeps {
  platform?: NodeJS.Platform;
  getCurrentUid?: () => number | null;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  execFile?: (
    command: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean },
  ) => Promise<{ stdout: string }>;
}

const LINUX_LOOPBACK_IPV4_HEX = "0100007F";
const LINUX_LOOPBACK_IPV4_MAPPED_IPV6_HEX = "0000000000000000FFFF00000100007F";
const LOOKUP_TIMEOUT_MS = 3_000;

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

  let cachedWindowsCurrentSid: Promise<string | null> | null = null;

  const getWindowsCurrentSid = (): Promise<string | null> => {
    if (!cachedWindowsCurrentSid) {
      cachedWindowsCurrentSid = execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ],
        { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
      )
        .then((res) => parseWindowsLoopbackSocketOwner(res.stdout))
        .catch(() => null);
    }
    return cachedWindowsCurrentSid;
  };

  return async ({ clientPort, serverPort }: SocketOwnerCheckInput): Promise<boolean> => {
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
      const expectedSid = await getWindowsCurrentSid();
      if (!expectedSid) return false;
      try {
        const script = [
          `$conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${clientPort} -RemoteAddress 127.0.0.1 -RemotePort ${serverPort} -ErrorAction SilentlyContinue | Select-Object -First 1;`,
          "if ($conn) {",
          '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue;',
          "  if ($proc) { (Invoke-CimMethod -InputObject $proc -MethodName GetOwnerSid).Sid }",
          "}",
        ].join(" ");
        const { stdout } = await execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true },
        );
        const ownerSid = parseWindowsLoopbackSocketOwner(stdout);
        return ownerSid !== null && ownerSid === expectedSid;
      } catch {
        return false;
      }
    }

    return false;
  };
}
