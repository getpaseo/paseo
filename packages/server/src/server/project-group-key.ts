import { resolve } from "node:path";

/**
 * Derives the persisted, opaque equivalence key used to group projects across hosts.
 * A Git remote is today's strongest shared fact, but callers treat the result as opaque.
 */
export function deriveProjectGroupKey(input: {
  rootPath: string;
  remoteUrl: string | null;
  mainRepoRoot: string | null;
}): string {
  return (
    deriveRemoteProjectGroupKey(input.remoteUrl) ?? resolve(input.mainRepoRoot ?? input.rootPath)
  );
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
      host = parsed.hostname || null;
      remotePath = parsed.pathname ? parsed.pathname.replace(/^\/+/, "") : null;
    } catch {
      return null;
    }
  }

  if (!host || !remotePath) return null;
  let cleanedPath = remotePath.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) cleanedPath = cleanedPath.slice(0, -4);
  if (!cleanedPath.includes("/")) return null;
  return `remote:${host.toLowerCase()}/${cleanedPath}`;
}
