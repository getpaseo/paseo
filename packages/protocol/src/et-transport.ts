import { DEFAULT_SSH_DAEMON_PORT, validatePort, validateSshHost } from "./ssh-transport.js";

export const DEFAULT_ET_PORT = 2022;

export interface EtTransportTarget {
  host: string;
  etPort: number;
  sshPort?: number;
  daemonPort: number;
}

export function validateEtHost(value: string): string {
  const host = validateSshHost(value);
  const parts = host.split("@");
  const hostname = parts.at(-1) ?? "";
  const username = parts.length === 2 ? parts[0] : undefined;
  if (
    parts.length > 2 ||
    (username !== undefined && !/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(username))
  ) {
    throw new Error("ET host is invalid");
  }
  if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(hostname)) return host;
  if (/^[0-9A-Fa-f:.]+$/.test(hostname) && hostname.includes(":")) {
    try {
      const address = new URL(`et://[${hostname}]`).hostname.slice(1, -1);
      return username ? `${username}@${address}` : address;
    } catch {
      throw new Error("ET host is invalid");
    }
  }
  throw new Error("ET host is invalid");
}

export function parseEtTransportUri(
  value: string,
  options?: { allowDaemonPassword: boolean },
): EtTransportTarget {
  const authority = /^et:\/\/([A-Za-z0-9_.:@[\]%-]+)\/?(?:\?[^#]*)?$/u.exec(value)?.[1];
  if (!authority) throw new Error("Invalid ET host URI");
  const userinfo = authority.slice(0, authority.lastIndexOf("@") + 1);
  if (userinfo === "@" || userinfo.includes(":") || authority.endsWith(":")) {
    throw new Error("Invalid ET host URI");
  }

  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error("Invalid ET host URI");
  }
  for (const key of uri.searchParams.keys()) {
    if (key === "password" && options?.allowDaemonPassword) continue;
    if (key !== "sshPort" && key !== "daemonPort") throw new Error("Unsupported ET host option");
  }

  const sshPort = parseQueryPort(uri, "sshPort", "SSH port");
  const daemonPort = parseQueryPort(uri, "daemonPort", "Daemon port") ?? DEFAULT_SSH_DAEMON_PORT;
  const etPort = uri.port ? validatePort(uri.port, "ET port") : DEFAULT_ET_PORT;
  const hostname = uri.hostname.startsWith("[") ? uri.hostname.slice(1, -1) : uri.hostname;
  let username: string;
  try {
    username = decodeURIComponent(uri.username);
  } catch {
    throw new Error("Invalid ET host URI");
  }
  const host = validateEtHost(username ? `${username}@${hostname}` : hostname);
  return {
    host,
    etPort,
    ...(sshPort !== undefined ? { sshPort } : {}),
    daemonPort,
  };
}

function parseQueryPort(uri: URL, key: string, label: string): number | undefined {
  const values = uri.searchParams.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^\d+$/u.test(values[0])) {
    throw new Error(`Invalid ${label}`);
  }
  return validatePort(values[0], label);
}

export function buildEtTunnelArgs(target: EtTransportTarget): string[] {
  const host = validateEtHost(target.host);
  const etPort = validatePort(target.etPort, "ET port");
  const daemonPort = validatePort(target.daemonPort, "Daemon port");
  // ET's -o applies to its own session. Its bootstrap ssh also reads SSH config.
  const args = [
    "--no-persist",
    "--disconnect-timeout",
    "1",
    "--port",
    String(etPort),
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "--ssh-option",
    "ConnectTimeout=10",
    "--ssh-option",
    "ClearAllForwardings=yes",
    "--ssh-option",
    "ForwardAgent=no",
    "--ssh-option",
    "ControlPath=none",
    "--ssh-option",
    "RemoteCommand=none",
  ];
  if (target.sshPort !== undefined) {
    args.push("-p", String(validatePort(target.sshPort, "SSH port")));
  }
  args.push("-W", `127.0.0.1:${daemonPort}`, host);
  return args;
}
