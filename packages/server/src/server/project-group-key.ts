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

  let host: string | null = null;
  let remotePath: string | null = null;
  let preserveLeadingSlash = false;
  const scpLike =
    !trimmed.includes("://") && !/^[A-Za-z]:[\\/]/.test(trimmed)
      ? trimmed.match(/^(?:[^@/:]+@)?(\[[^\]]+\]|[^/:]+):(.+)$/)
      : null;
  if (scpLike) {
    host = scpLike[1] ?? null;
    remotePath = scpLike[2] ?? null;
    preserveLeadingSlash = remotePath?.startsWith("/") ?? false;
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = deriveRemoteHost(parsed);
      remotePath = parsed.pathname ? parsed.pathname.replace(/^\/+/, "") : null;
    } catch {
      return null;
    }
  }

  if (!host || !remotePath) return null;
  const cleanedPath = normalizeRemotePath(remotePath, preserveLeadingSlash);
  if (!cleanedPath) return null;
  return `remote:${host.toLowerCase()}/${cleanedPath}`;
}

function normalizeRemotePath(remotePath: string, preserveLeadingSlash: boolean): string {
  const trimmedPath = remotePath.trim().replace(/\/+$/, "");
  const pathForEncoding = preserveLeadingSlash ? trimmedPath : trimmedPath.replace(/^\/+/, "");
  const segments = pathForEncoding.split("/");
  const decodedSegments = segments.map((segment) => {
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
