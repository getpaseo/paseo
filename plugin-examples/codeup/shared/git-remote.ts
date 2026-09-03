// Remote parsing is runtime-neutral and shared by service code and tests.
const TRANSPORT_BY_PROTOCOL = {
  "https:": "https",
  "http:": "http",
  "ssh:": "ssh",
} as const;

const DEFAULT_PORT_BY_PROTOCOL: Record<string, string> = {
  "https:": "443",
  "http:": "80",
  "ssh:": "22",
};

export interface GitRemoteLocation {
  transport: "scp" | "ssh" | "http" | "https";
  host: string;
  port?: string;
  path: string;
}

export function parseGitRemoteLocation(remoteUrl: string): GitRemoteLocation | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scpLike = trimmed.includes("://") ? null : trimmed.match(/^[^@]+@([^:]+):(.+)$/u);
  if (scpLike) {
    const host = normalizeHost(scpLike[1] ?? "");
    const path = normalizeRemotePath(scpLike[2] ?? "");
    if (!isValidRemoteHost(host) || !path) return null;
    return { transport: "scp", host, path };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const transport = TRANSPORT_BY_PROTOCOL[parsed.protocol as keyof typeof TRANSPORT_BY_PROTOCOL];
  if (!transport) return null;
  const host = normalizeHost(parsed.hostname);
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const normalizedPath = normalizeRemotePath(path);
  if (!isValidRemoteHost(host) || !normalizedPath) return null;
  const protocol = parsed.protocol.toLowerCase();
  const port =
    parsed.port && parsed.port !== DEFAULT_PORT_BY_PROTOCOL[protocol] ? parsed.port : undefined;
  return { transport, host, ...(port ? { port } : {}), path: normalizedPath };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.+$/u, "").toLowerCase();
}

function normalizeRemotePath(path: string): string | null {
  let normalized = path.trim().replace(/^\/+|\/+$/gu, "");
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  return normalized || null;
}

function isValidRemoteHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(host);
}
