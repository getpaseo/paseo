import { resolve } from "node:path";
import { getRealpathAwareRelativePath } from "../utils/path.js";

/**
 * Derives the persisted, opaque equivalence key used to group projects across hosts.
 * A Git remote is today's strongest shared fact, but callers treat the result as opaque.
 */
export function deriveProjectGroupKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  worktreeRoot: string | null;
  mainRepoRoot: string | null;
}): string {
  const remoteKey = deriveRemoteProjectGroupKey(input.remoteUrl);
  const selectedPath = deriveSelectedPath(input.rootPath, input.worktreeRoot);
  if (!remoteKey) {
    return selectedPath && input.mainRepoRoot
      ? resolve(input.mainRepoRoot, selectedPath)
      : resolve(input.mainRepoRoot ?? input.rootPath);
  }

  return selectedPath ? `${remoteKey}#subdir:${encodeSelectedPath(selectedPath)}` : remoteKey;
}

function deriveSelectedPath(rootPath: string, worktreeRoot: string | null): string | null {
  if (!worktreeRoot) return null;
  return getRealpathAwareRelativePath(worktreeRoot, rootPath) || null;
}

function encodeSelectedPath(selectedPath: string): string {
  return selectedPath.split(/[\\/]/u).map(encodeURIComponent).join("/");
}

function deriveRemoteProjectGroupKey(remoteUrl: string | null): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return null;
  const remote = parseRemoteLocation(trimmed);
  if (!remote) return null;
  const cleanedPath = normalizeRemotePath(
    remote.path,
    remote.preserveLeadingSlash,
    remote.decodePercentEncoding,
  );
  if (!cleanedPath) return null;
  const userPrefix = remote.relativePathUser
    ? `${encodeURIComponent(remote.relativePathUser)}@`
    : "";
  return `remote:${userPrefix}${remote.host.toLowerCase()}/${cleanedPath}`;
}

interface RemoteLocation {
  host: string;
  path: string;
  relativePathUser: string | null;
  preserveLeadingSlash: boolean;
  decodePercentEncoding: boolean;
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
  return {
    host,
    path: remotePath,
    relativePathUser: user && user !== "git" && !preserveLeadingSlash ? user : null,
    preserveLeadingSlash,
    decodePercentEncoding: false,
  };
}

function parseUrlRemote(remoteUrl: string): RemoteLocation | null {
  try {
    const parsed = new URL(remoteUrl);
    const host = deriveRemoteHost(parsed);
    const remotePath = parsed.pathname ? parsed.pathname.replace(/^\/+/, "") : null;
    if (!host || !remotePath) return null;
    return {
      host,
      path: remotePath,
      relativePathUser: null,
      preserveLeadingSlash: false,
      decodePercentEncoding: true,
    };
  } catch {
    return null;
  }
}

function normalizeRemotePath(
  remotePath: string,
  preserveLeadingSlash: boolean,
  decodePercentEncoding: boolean,
): string {
  const trimmedPath = remotePath.trim().replace(/\/+$/, "");
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
  if (lastSegment?.endsWith(".git")) decodedSegments[lastIndex] = lastSegment.slice(0, -4);
  return decodedSegments.map(encodeURIComponent).join("/");
}

function deriveRemoteHost(remoteUrl: URL): string | null {
  const defaultPorts: Partial<Record<string, string>> = {
    "git:": "9418",
    "git+ssh:": "22",
    "ssh:": "22",
    "ssh+git:": "22",
  };
  if (remoteUrl.port === defaultPorts[remoteUrl.protocol]) return remoteUrl.hostname || null;
  return remoteUrl.host || null;
}
