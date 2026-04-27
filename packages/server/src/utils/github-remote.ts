import { findExecutable } from "./executable.js";
import { execCommand } from "./spawn.js";

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);

const TRANSPORT_BY_PROTOCOL: Record<string, GitRemoteLocation["transport"]> = {
  "https:": "https",
  "http:": "http",
  "ssh:": "ssh",
};

let sshExecutableLookup: Promise<string | null> | null = null;
const sshHostnameResolutionCache = new Map<string, Promise<string | null>>();

interface GitRemoteLocation {
  transport: "scp" | "ssh" | "http" | "https";
  host: string;
  path: string;
}

export interface GitHubRemoteIdentity {
  owner: string;
  name: string;
  repo: string;
}

export type SshHostnameResolver = (host: string) => Promise<string | null>;

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemoteIdentity | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location || !GITHUB_HOSTS.has(location.host)) return null;
  return parseGitHubRemoteIdentity(location.path);
}

export async function resolveGitHubRemote(input: {
  remoteUrl: string;
  resolveSshHostname?: SshHostnameResolver;
}): Promise<GitHubRemoteIdentity | null> {
  const location = parseGitRemoteLocation(input.remoteUrl);
  if (!location) return null;
  if (GITHUB_HOSTS.has(location.host)) return parseGitHubRemoteIdentity(location.path);
  if (location.transport !== "scp" && location.transport !== "ssh") return null;

  const resolve = input.resolveSshHostname ?? resolveSshHostname;
  const resolvedHost = await resolve(location.host);
  if (!resolvedHost || !GITHUB_HOSTS.has(resolvedHost)) return null;
  return parseGitHubRemoteIdentity(location.path);
}

export async function resolveSshHostname(host: string): Promise<string | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;

  const cached = sshHostnameResolutionCache.get(normalized);
  if (cached) return cached;

  const resolution = runSshHostnameLookup(normalized);
  sshHostnameResolutionCache.set(normalized, resolution);
  return resolution;
}

async function runSshHostnameLookup(host: string): Promise<string | null> {
  sshExecutableLookup ??= findExecutable("ssh");
  const sshPath = await sshExecutableLookup;
  if (!sshPath) return null;

  try {
    const { stdout } = await execCommand(sshPath, ["-G", host], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
    });
    return parseSshHostname(stdout);
  } catch {
    return null;
  }
}

function parseSshHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [key, value] = trimmed.split(/\s+/u);
    if (key?.toLowerCase() !== "hostname") continue;
    const normalized = normalizeHost(value ?? "");
    if (normalized) return normalized;
  }
  return null;
}

function parseGitRemoteLocation(remoteUrl: string): GitRemoteLocation | null {
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

function parseGitHubRemoteIdentity(path: string): GitHubRemoteIdentity | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!owner || !name) return null;
  return { owner, name, repo: `${owner}/${name}` };
}

function normalizeRemotePath(path: string): string | null {
  let normalized = path.trim().replace(/^\/+|\/+$/gu, "");
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  return normalized || null;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.+$/u, "").toLowerCase();
}

function isValidRemoteHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(host);
}
