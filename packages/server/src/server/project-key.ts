import { resolve, win32 } from "node:path";
import { FORGE_DEFINITIONS } from "@getpaseo/protocol/forge-manifest";
import { getRealpathAwareRelativePath } from "../utils/path.js";

const CLOUD_FORGE_HOSTS = new Set(
  FORGE_DEFINITIONS.flatMap((forge) => forge.cloudHosts ?? []).map((host) => host.toLowerCase()),
);
const CANONICAL_CLOUD_FORGE_HOSTS = new Map(
  FORGE_DEFINITIONS.flatMap((forge) => {
    const hosts = forge.cloudHosts ?? [];
    const canonicalHost = hosts[0]?.toLowerCase();
    return canonicalHost ? hosts.map((host) => [host.toLowerCase(), canonicalHost] as const) : [];
  }),
);
const DEFAULT_REMOTE_PORTS: Partial<Record<string, string>> = {
  "git:": "9418",
  "git+ssh:": "22",
  "ssh:": "22",
  "ssh+git:": "22",
};

/**
 * Derives the persisted, opaque equivalence key used to group projects across hosts.
 * A Git remote is today's strongest shared fact, but callers treat the result as opaque.
 */
export function deriveProjectKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
  mainRepoRoot: string | null;
  serverId?: string;
}): string {
  const remoteKey = deriveRemoteProjectKey(input.remoteUrl);
  const selectedPath = deriveSelectedPath(input.rootPath, input.worktreeRoot);
  if (!remoteKey) {
    const localPathParts =
      selectedPath && input.mainRepoRoot
        ? [input.mainRepoRoot, selectedPath]
        : [input.mainRepoRoot ?? input.rootPath];
    const localPath = resolveLocalProjectPath(...localPathParts);
    return input.serverId
      ? `host:${input.serverId.length}:${input.serverId}:path:${localPath}`
      : localPath;
  }

  return selectedPath
    ? `${remoteKey}#subdir:${encodeSelectedPath(selectedPath, input.worktreeRoot ?? input.rootPath)}`
    : remoteKey;
}

function resolveLocalProjectPath(...parts: string[]): string {
  return parts.some(looksLikeWindowsPath)
    ? win32.resolve(...parts).toLowerCase()
    : resolve(...parts);
}

function deriveSelectedPath(rootPath: string, worktreeRoot: string | null): string | null {
  if (!worktreeRoot) return null;
  return getRealpathAwareRelativePath(worktreeRoot, rootPath) || null;
}

function encodeSelectedPath(selectedPath: string, sourcePath: string): string {
  const isWindowsPath = looksLikeWindowsPath(sourcePath);
  const stableSelectedPath = isWindowsPath ? selectedPath.toLowerCase() : selectedPath;
  const segments = isWindowsPath
    ? stableSelectedPath.split(/[\\/]/u)
    : stableSelectedPath.split("/");
  return segments.map(encodeURIComponent).join("/");
}

function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
  if (!remoteUrl?.trim()) return null;
  const remote = parseRemoteLocation(remoteUrl);
  if (!remote) return null;
  const cleanedPath = normalizeRemotePath(
    remote.path,
    remote.preserveLeadingSlash,
    remote.decodePercentEncoding,
    remote.stripDotGitSuffix,
  );
  if (!cleanedPath) return null;
  const userPrefix = remote.user ? `${encodeURIComponent(remote.user)}@` : "";
  const normalizedHost = remote.host.toLowerCase();
  const normalizedPath = normalizedHost === "github.com" ? cleanedPath.toLowerCase() : cleanedPath;
  const transportPrefix = remote.transport ? `${remote.transport}//` : "";
  return `remote:${transportPrefix}${userPrefix}${normalizedHost}/${normalizedPath}`;
}

interface RemoteLocation {
  host: string;
  path: string;
  displayPath: string;
  transport: string | null;
  user: string | null;
  preserveLeadingSlash: boolean;
  decodePercentEncoding: boolean;
  stripDotGitSuffix: boolean;
}

function parseRemoteLocation(remoteUrl: string): RemoteLocation | null {
  return remoteUrl.includes("://") ? parseUrlRemote(remoteUrl) : parseScpRemote(remoteUrl);
}

function parseScpRemote(remoteUrl: string): RemoteLocation | null {
  if (/^[A-Za-z]:/.test(remoteUrl)) return null;
  const match = remoteUrl.match(/^(?:(?<user>[^@/:]+)@)?(?<host>\[[^\]]+\]|[^/:]+):(?<path>.+)$/);
  const host = match?.groups?.host;
  const remotePath = match?.groups?.path;
  if (!host || !remotePath) return null;

  const preserveLeadingSlash = remotePath.startsWith("/");
  const user = match.groups?.user;
  const normalizedHost = normalizeCloudForgeHost(host);
  return {
    host: normalizedHost,
    path: remotePath,
    displayPath: remotePath,
    transport: null,
    user: user && (user !== "git" || !CLOUD_FORGE_HOSTS.has(host.toLowerCase())) ? user : null,
    preserveLeadingSlash,
    decodePercentEncoding: false,
    stripDotGitSuffix: CLOUD_FORGE_HOSTS.has(host.toLowerCase()),
  };
}

function parseUrlRemote(remoteUrl: string): RemoteLocation | null {
  try {
    const parsed = new URL(remoteUrl);
    const isSsh = ["git+ssh:", "ssh:", "ssh+git:"].includes(parsed.protocol);
    const forgeHost = deriveCanonicalUrlForgeHost(parsed, isSsh);
    const host = forgeHost ?? deriveRemoteHost(parsed);
    const preserveLeadingSlash = isSsh && !forgeHost;
    const paths = deriveUrlRemotePaths(parsed, {
      isSsh,
      isForge: forgeHost !== null,
      preserveLeadingSlash,
    });
    if (!host || !paths) return null;
    return {
      host,
      path: paths.identity,
      displayPath: paths.display,
      transport: forgeHost || isSsh ? null : parsed.protocol.toLowerCase(),
      user: isSsh && !forgeHost && parsed.username ? decodeUrlComponent(parsed.username) : null,
      preserveLeadingSlash,
      decodePercentEncoding: true,
      stripDotGitSuffix: forgeHost !== null,
    };
  } catch {
    return null;
  }
}

function deriveUrlRemotePaths(
  remoteUrl: URL,
  input: { isSsh: boolean; isForge: boolean; preserveLeadingSlash: boolean },
): { identity: string; display: string } | null {
  if (!remoteUrl.pathname) return null;
  const identitySuffix = deriveUrlIdentitySuffix(remoteUrl, input);
  const normalize = (value: string) =>
    input.preserveLeadingSlash ? value : value.replace(/^\/+/, "");
  return {
    identity: normalize(`${remoteUrl.pathname}${identitySuffix}`),
    display: normalize(remoteUrl.pathname),
  };
}

function deriveUrlIdentitySuffix(
  remoteUrl: URL,
  input: { isSsh: boolean; isForge: boolean },
): string {
  if (input.isSsh) return `${remoteUrl.search}${remoteUrl.hash}`;
  if (input.isForge) return "";
  return remoteUrl.search;
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeCloudForgeHost(host: string): string {
  return CANONICAL_CLOUD_FORGE_HOSTS.get(host.toLowerCase()) ?? host;
}

function deriveCanonicalUrlForgeHost(remoteUrl: URL, isSsh: boolean): string | null {
  const hostname = remoteUrl.hostname.toLowerCase();
  const canonicalHost = CANONICAL_CLOUD_FORGE_HOSTS.get(hostname);
  if (!canonicalHost) return null;
  const usesDefaultPort =
    !remoteUrl.port || remoteUrl.port === DEFAULT_REMOTE_PORTS[remoteUrl.protocol];
  const usesGithubSshAliasPort = isSsh && hostname === "ssh.github.com" && remoteUrl.port === "443";
  return usesDefaultPort || usesGithubSshAliasPort ? canonicalHost : null;
}

function normalizeRemotePath(
  remotePath: string,
  preserveLeadingSlash: boolean,
  decodePercentEncoding: boolean,
  stripDotGitSuffix: boolean,
): string {
  const trimmedPath = remotePath.replace(/\/+$/, "");
  const pathForEncoding = preserveLeadingSlash ? trimmedPath : trimmedPath.replace(/^\/+/, "");
  const segments = pathForEncoding.split("/");
  const decodedSegments = segments.map((segment) => {
    if (!decodePercentEncoding) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const lastIndex = decodedSegments.length - 1;
  const lastSegment = decodedSegments[lastIndex];
  if (stripDotGitSuffix && lastSegment?.endsWith(".git")) {
    decodedSegments[lastIndex] = lastSegment.slice(0, -4);
  }
  return decodedSegments.map(encodeURIComponent).join("/");
}

export function deriveProjectGroupingDisplayName(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
}): string {
  if (deriveSelectedPath(input.rootPath, input.worktreeRoot)) {
    return lastPathSegment(input.rootPath);
  }

  const trimmed = input.remoteUrl?.trim();
  const remote = trimmed ? parseRemoteLocation(trimmed) : null;
  if (!remote) {
    return lastPathSegment(input.rootPath);
  }

  const segments = remote.displayPath
    .trim()
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (!remote.decodePercentEncoding) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const lastIndex = segments.length - 1;
  const lastSegment = segments[lastIndex];
  if (lastSegment?.endsWith(".git")) segments[lastIndex] = lastSegment.slice(0, -4);
  return segments.slice(-2).join("/") || input.rootPath;
}

function lastPathSegment(inputPath: string): string {
  const segments = inputPath.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] ?? inputPath;
}

function deriveRemoteHost(remoteUrl: URL): string | null {
  if (remoteUrl.port === DEFAULT_REMOTE_PORTS[remoteUrl.protocol])
    return remoteUrl.hostname || null;
  return remoteUrl.host || null;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || /^\\{2}[^\\/]+[\\/][^\\/]+/u.test(value);
}
