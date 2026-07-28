import { isAbsolute, relative, resolve, sep } from "node:path";

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
  if (!remoteKey) return resolve(input.mainRepoRoot ?? input.rootPath);

  const selectedPath = deriveSelectedPath(input.rootPath, input.worktreeRoot);
  return selectedPath ? `${remoteKey}#subdir:${selectedPath}` : remoteKey;
}

function deriveSelectedPath(rootPath: string, worktreeRoot: string | null): string | null {
  if (!worktreeRoot) return null;
  const selectedPath = relative(resolve(worktreeRoot), resolve(rootPath));
  if (
    !selectedPath ||
    selectedPath === "." ||
    selectedPath === ".." ||
    selectedPath.startsWith(`..${sep}`) ||
    isAbsolute(selectedPath)
  ) {
    return null;
  }
  return selectedPath.split(sep).map(encodeURIComponent).join("/");
}

function deriveRemoteProjectGroupKey(remoteUrl: string | null): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return null;

  let host: string | null = null;
  let remotePath: string | null = null;
  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1] ?? null;
    remotePath = scpLike[2] ?? null;
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.host || null;
      remotePath = parsed.pathname ? parsed.pathname.replace(/^\/+/, "") : null;
    } catch {
      return null;
    }
  }

  if (!host || !remotePath) return null;
  let cleanedPath = remotePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) cleanedPath = cleanedPath.slice(0, -4);
  if (!cleanedPath) return null;
  return `remote:${host.toLowerCase()}/${cleanedPath}`;
}
