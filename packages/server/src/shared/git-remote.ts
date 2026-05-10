const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);

const TRANSPORT_BY_PROTOCOL: Record<string, GitRemoteLocation["transport"]> = {
  "https:": "https",
  "http:": "http",
  "ssh:": "ssh",
};

export interface GitRemoteLocation {
  transport: "scp" | "ssh" | "http" | "https";
  host: string;
  path: string;
}

export interface GitHubRemoteIdentity {
  owner: string;
  name: string;
  repo: string;
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemoteIdentity | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !isGitHubHost(location.host)) return null;
  return parseGitHubRemoteIdentity(location.path);
}

export function parseGitRemoteLocation(remoteUrl: string): GitRemoteLocation | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/u);
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

  const transport = TRANSPORT_BY_PROTOCOL[parsed.protocol.toLowerCase()];
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

  return { transport, host, path: normalizedPath };
}

export function parseGitHubRemoteIdentity(path: string): GitHubRemoteIdentity | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!owner || !name) return null;
  return { owner, name, repo: `${owner}/${name}` };
}

export function isGitHubHost(host: string): boolean {
  return GITHUB_HOSTS.has(host);
}

export function normalizeHost(host: string): string {
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
