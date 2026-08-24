import { normalizeHost } from "@getpaseo/protocol/git-remote";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { execCommand } from "./spawn.js";

export type SshHostnameResolver = (host: string) => Promise<string | null>;

const SSH_HOSTNAME_RESOLVE_TIMEOUT_MS = 5_000;

let sshExecutableLookup: Promise<string | null> | null = null;
const sshHostnameResolutionCache = new Map<string, Promise<string | null>>();

/**
 * Resolve an SSH host alias (e.g. `github-work` from ~/.ssh/config) to its
 * configured HostName via `ssh -G`. Results are cached for the daemon's
 * lifetime; a host that isn't an alias resolves to itself.
 */
export async function resolveSshHostname(host: string): Promise<string | null> {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return null;
  }

  const cached = sshHostnameResolutionCache.get(normalized);
  if (cached) {
    return cached;
  }

  const resolution = runSshHostnameLookup(normalized);
  sshHostnameResolutionCache.set(normalized, resolution);
  return resolution;
}

async function runSshHostnameLookup(host: string): Promise<string | null> {
  sshExecutableLookup ??= findExecutable("ssh");
  const sshPath = await sshExecutableLookup;
  if (!sshPath) {
    return null;
  }

  try {
    const { stdout } = await execCommand(sshPath, ["-G", host], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
      timeout: SSH_HOSTNAME_RESOLVE_TIMEOUT_MS,
    });
    return parseSshHostname(stdout);
  } catch {
    return null;
  }
}

function parseSshHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [key, value] = trimmed.split(/\s+/u);
    if (key?.toLowerCase() !== "hostname") {
      continue;
    }
    const normalized = normalizeHost(value ?? "");
    if (normalized) {
      return normalized;
    }
  }
  return null;
}
