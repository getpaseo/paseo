import { replaceEqualDeep } from "@tanstack/react-query";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const PROVIDERS_SNAPSHOT_QUERY_ROOT = "providersSnapshot";

interface SnapshotOrder {
  time: number;
  pushed: boolean;
}

function snapshotOrder(value: unknown): SnapshotOrder {
  if (typeof value !== "object" || value === null || !("generatedAt" in value)) {
    return { time: Number.NEGATIVE_INFINITY, pushed: false };
  }
  const time = typeof value.generatedAt === "string" ? Date.parse(value.generatedAt) : NaN;
  return {
    time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY,
    pushed: "requestId" in value && value.requestId === "providers_snapshot_update",
  };
}

// Reconcile at React Query's write boundary: a ready push can arrive after the
// query function returns, while its loading response is still being committed.
export function reconcileProvidersSnapshot<T>(current: T | undefined, incoming: T): T {
  if (current === undefined) return incoming;
  const previous = snapshotOrder(current);
  const next = snapshotOrder(incoming);
  const fetchedAfterEqualPush = previous.time === next.time && previous.pushed && !next.pushed;
  if (previous.time > next.time || fetchedAfterEqualPush) return current;
  return replaceEqualDeep(current, incoming);
}

export function normalizeProvidersSnapshotCwd(cwd?: string | null): string | null {
  return normalizeWorkspacePath(cwd);
}

export function providersSnapshotQueryRoot(serverId: string | null) {
  return [PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId] as const;
}

export function providersSnapshotQueryKey(serverId: string | null, cwd?: string | null) {
  const normalizedCwd = normalizeProvidersSnapshotCwd(cwd);
  return normalizedCwd
    ? ([PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId, "cwd", normalizedCwd] as const)
    : ([PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId, "home"] as const);
}

export function providersSnapshotRequestOptions(input: {
  cwd?: string | null;
  providers?: AgentProvider[];
  ifNoneMatch?: string;
}) {
  const normalizedCwd = normalizeProvidersSnapshotCwd(input.cwd);
  return {
    ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    ...(input.providers ? { providers: input.providers } : {}),
    ...(input.ifNoneMatch ? { ifNoneMatch: input.ifNoneMatch } : {}),
  };
}

export function isProvidersSnapshotHomeScope(cwd?: string | null): boolean {
  return normalizeProvidersSnapshotCwd(cwd) === null;
}
