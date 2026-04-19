import { findExecutable } from "./executable.js";
import { execCommand } from "./spawn.js";

const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);
const SSH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
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

export interface ResolveGitHubRemoteInput {
  remoteUrl: string;
  resolveSshHostname?: SshHostnameResolver;
}

export interface ResolveSshHostnameInput {
  host: string;
}

export type SshHostnameResolver = (input: ResolveSshHostnameInput) => Promise<string | null>;

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemoteIdentity | null {
  const location = parseGitRemoteLocation(remoteUrl);
  if (!location) {
    return null;
  }
  if (!isGitHubHost(location.host)) {
    return null;
  }
  return parseGitHubRemoteIdentity(location.path);
}

export async function resolveGitHubRemote(
  input: ResolveGitHubRemoteInput,
): Promise<GitHubRemoteIdentity | null> {
  const location = parseGitRemoteLocation(input.remoteUrl);
  if (!location) {
    return null;
  }
  if (isGitHubHost(location.host)) {
    return parseGitHubRemoteIdentity(location.path);
  }
  if (!isSshTransport(location.transport)) {
    return null;
  }

  const resolveHostname = input.resolveSshHostname ?? resolveSshHostname;
  const resolvedHost = await resolveHostname({ host: location.host });
  if (!resolvedHost || !isGitHubHost(resolvedHost)) {
    return null;
  }

  return parseGitHubRemoteIdentity(location.path);
}

export async function resolveSshHostname(input: ResolveSshHostnameInput): Promise<string | null> {
  const host = normalizeHost(input.host);
  if (!host) {
    return null;
  }

  const cached = sshHostnameResolutionCache.get(host);
  if (cached) {
    return cached;
  }

  const resolution = loadResolvedSshHostname({ host }).catch(() => null);
  sshHostnameResolutionCache.set(host, resolution);
  return resolution;
}

async function loadResolvedSshHostname(input: ResolveSshHostnameInput): Promise<string | null> {
  const sshPath = await resolveSshExecutablePath();
  if (!sshPath) {
    return null;
  }

  try {
    const { stdout } = await execCommand(sshPath, ["-G", input.host], {
      env: SSH_ENV,
      maxBuffer: 1024 * 1024,
    });
    return parseResolvedSshHostname(stdout);
  } catch {
    return null;
  }
}

async function resolveSshExecutablePath(): Promise<string | null> {
  sshExecutableLookup ??= findExecutable("ssh");
  return sshExecutableLookup;
}

function parseResolvedSshHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split(/\s+/u);
    if (key?.toLowerCase() !== "hostname") {
      continue;
    }

    const value = normalizeHost(valueParts.join(" "));
    if (value) {
      return value;
    }
  }

  return null;
}

function parseGitRemoteLocation(remoteUrl: string): GitRemoteLocation | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/u);
  if (scpLike) {
    const host = normalizeHost(scpLike[1] ?? "");
    const path = normalizeRemotePath(scpLike[2] ?? "");
    if (!host || !path) {
      return null;
    }
    return { transport: "scp", host, path };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
    return null;
  }

  const host = normalizeHost(parsed.hostname);
  const decodedPath = decodeRemotePath(parsed.pathname);
  const path = normalizeRemotePath(decodedPath);
  if (!host || !path) {
    return null;
  }

  return {
    transport: protocol === "ssh:" ? "ssh" : protocol === "http:" ? "http" : "https",
    host,
    path,
  };
}

function parseGitHubRemoteIdentity(path: string): GitHubRemoteIdentity | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }

  const [owner, name] = segments;
  if (!owner || !name) {
    return null;
  }

  return {
    owner,
    name,
    repo: `${owner}/${name}`,
  };
}

function decodeRemotePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function normalizeRemotePath(path: string | null): string | null {
  if (!path) {
    return null;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  let normalized = trimmed.replace(/^\/+|\/+$/gu, "");
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -".git".length);
  }

  return normalized || null;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/\.+$/u, "").toLowerCase();
}

function isGitHubHost(host: string): boolean {
  return GITHUB_HOSTS.has(normalizeHost(host));
}

function isSshTransport(transport: GitRemoteLocation["transport"]): boolean {
  return transport === "scp" || transport === "ssh";
}
