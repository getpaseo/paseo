import {
  isGitHubHost,
  normalizeHost,
  parseGitHubRemoteIdentity,
  parseGitRemoteLocation,
  type GitHubRemoteIdentity as ResolvedGitHubRemoteIdentity,
} from "../shared/git-remote.js";
import { findExecutable } from "./executable.js";
import { execCommand } from "./spawn.js";

let sshExecutableLookup: Promise<string | null> | null = null;
const sshHostnameResolutionCache = new Map<string, Promise<string | null>>();

export type SshHostnameResolver = (host: string) => Promise<string | null>;

export { parseGitHubRemoteUrl, type GitHubRemoteIdentity } from "../shared/git-remote.js";

export async function resolveGitHubRemote(input: {
  remoteUrl: string;
  resolveSshHostname?: SshHostnameResolver;
}): Promise<ResolvedGitHubRemoteIdentity | null> {
  const location = parseGitRemoteLocation(input.remoteUrl);
  if (!location) return null;
  if (isGitHubHost(location.host)) return parseGitHubRemoteIdentity(location.path);
  if (location.transport !== "scp" && location.transport !== "ssh") return null;

  const resolve = input.resolveSshHostname ?? resolveSshHostname;
  const resolvedHost = await resolve(location.host);
  if (!resolvedHost || !isGitHubHost(resolvedHost)) return null;
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
