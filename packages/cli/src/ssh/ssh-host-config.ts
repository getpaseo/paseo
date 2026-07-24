import { SshHostConnectionSchema } from "@getpaseo/protocol/host-connection-schema";

/**
 * A remote SSH host. The CLI tunnels daemon WebSocket traffic through an
 * SSH local port-forward to {@link remotePort} on the remote host, after making
 * sure a Paseo daemon is running there (installing Paseo first if needed).
 */
export interface SshHostConfig {
  /** Stable slug identifier (lowercase alphanumerics and hyphens). */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Remote hostname or IP address. */
  host: string;
  /** SSH port (default 22). */
  port: number;
  /** SSH user (optional — falls back to ssh config or current user). */
  user?: string;
  /** Remote daemon port to forward to (default 6767). */
  remotePort: number;
  /** Remote PASEO_HOME (default ~/.paseo). */
  remoteHome: string;
  /** Remote Paseo install directory (default ~/.paseo/cli). */
  installDir: string;
  /** Optional @getpaseo/cli version to install (default: the local CLI version). */
  packageVersion?: string;
}

const SSH_DEFAULTS = SshHostConnectionSchema.parse({
  id: "defaults",
  type: "ssh",
  host: "defaults",
  user: "defaults",
});

export const DEFAULT_SSH_PORT = SSH_DEFAULTS.port;
export const DEFAULT_REMOTE_PORT = SSH_DEFAULTS.remotePort;
export const DEFAULT_REMOTE_HOME = SSH_DEFAULTS.remoteHome;
export const DEFAULT_INSTALL_DIR = SSH_DEFAULTS.installDir;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSshHostId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function sshHostLabel(user: string | undefined, host: string): string {
  return user ? `${user}@${host}` : host;
}

/**
 * Validate and apply defaults to a raw SSH host config record. Throws on invalid
 * input so callers surface a clear error rather than silently persisting junk.
 */
export function normalizeSshHostConfig(
  input: Partial<SshHostConfig> & { id: string; host: string },
): SshHostConfig {
  if (!isValidSshHostId(input.id)) {
    throw new Error(
      `Invalid SSH host id "${input.id}": use lowercase alphanumerics and hyphens (max 63 chars).`,
    );
  }
  const host = input.host.trim();
  if (!host) throw new Error("SSH host is required");
  const user = input.user?.trim() || undefined;

  const port = validatePort(input.port ?? DEFAULT_SSH_PORT, "SSH port");
  const remotePort = validatePort(input.remotePort ?? DEFAULT_REMOTE_PORT, "remote daemon port");
  const label = (input.label ?? "").trim() || sshHostLabel(user, host);
  const remoteHome = (input.remoteHome ?? "").trim() || DEFAULT_REMOTE_HOME;
  const installDir = (input.installDir ?? "").trim() || DEFAULT_INSTALL_DIR;
  const packageVersion = input.packageVersion?.trim() || undefined;

  return {
    id: input.id,
    label,
    host,
    port,
    ...(user ? { user } : {}),
    remotePort,
    remoteHome,
    installDir,
    ...(packageVersion ? { packageVersion } : {}),
  };
}

/** A parsed `ssh://` URI — always an inline host. */
export interface ParsedSshHostUri {
  kind: "inline";
  config: SshHostConfig;
}

/**
 * Parse an `ssh://` URI into a structured form. Returns null for non-ssh URIs.
 *
 * Form: `ssh://[user@]host[:port]` — inline ad-hoc host with optional query params.
 *
 * Query params: remotePort, remoteHome, installDir, label, version.
 */
function parseSshUriOverrides(params: URLSearchParams): Partial<SshHostConfig> {
  const overrides: Partial<SshHostConfig> = {};
  const remotePortParam = params.get("remotePort");
  if (remotePortParam) overrides.remotePort = Number(remotePortParam);
  const remoteHome = params.get("remoteHome");
  if (remoteHome) overrides.remoteHome = remoteHome;
  const installDir = params.get("installDir");
  if (installDir) overrides.installDir = installDir;
  const label = params.get("label");
  if (label) overrides.label = label;
  const version = params.get("version");
  if (version) overrides.packageVersion = version;
  return overrides;
}

/** Split a `host[:port]` authority into host and optional port (IPv6-aware). */
function splitHostPort(hostPort: string): { host: string; port?: number } | null {
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]");
    if (close < 0) return null;
    const host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after.startsWith(":")) {
      return { host, port: Number(after.slice(1)) };
    }
    return { host };
  }
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon >= 0) {
    const maybePort = Number(hostPort.slice(lastColon + 1));
    if (Number.isInteger(maybePort) && maybePort > 0) {
      return { host: hostPort.slice(0, lastColon), port: maybePort };
    }
  }
  return { host: hostPort };
}

export function parseSshHostUri(uri: string): ParsedSshHostUri | null {
  const trimmed = uri.trim();
  if (!trimmed.startsWith("ssh://")) return null;

  const rest = trimmed.slice("ssh://".length);
  const queryIndex = rest.indexOf("?");
  const authority = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest;
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);

  const overrides = parseSshUriOverrides(params);

  // `ssh://[user@]host[:port]` is an inline host.
  const atIndex = authority.lastIndexOf("@");
  const user = atIndex >= 0 ? authority.slice(0, atIndex) || undefined : undefined;
  const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  if (!hostPort) return null;

  const split = splitHostPort(hostPort);
  if (!split) return null;
  const { host, port } = split;

  const config = normalizeSshHostConfig({
    id: (user ? `${user}@${host}` : host).replace(/[^a-z0-9-]/gi, "-").toLowerCase(),
    host,
    ...(user ? { user } : {}),
    ...(port ? { port } : {}),
    ...overrides,
  });

  return { kind: "inline", config };
}

export function isSshHostUri(uri: string): boolean {
  return typeof uri === "string" && uri.trim().startsWith("ssh://");
}

/**
 * Resolve an `ssh://` URI to a concrete config. Returns null for non-ssh URIs.
 */
export function resolveSshHostConfig(uri: string): SshHostConfig | null {
  const parsed = parseSshHostUri(uri);
  if (!parsed) return null;
  return parsed.config;
}
