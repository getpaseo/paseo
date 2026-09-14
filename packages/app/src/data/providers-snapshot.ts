import { CancelledError, type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GetProvidersSnapshotResponseMessage } from "@getpaseo/protocol/messages";
import {
  providerSnapshotCache,
  ProviderSnapshotCacheMissError,
  type ProviderSnapshotCache,
} from "./provider-snapshot-cache";
import { queryClient as singletonQueryClient } from "./query-client";
import { replaceProviderSnapshotIcons } from "@/components/provider-icon-name";
import { agentCommandsQueryRoot } from "@/hooks/agent-commands-query";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const PROVIDERS_SNAPSHOT_QUERY_ROOT = "providersSnapshot";

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

type Snapshot = GetProvidersSnapshotResponseMessage["payload"];
type SnapshotClient = Pick<DaemonClient, "getProvidersSnapshot">;

export async function fetchProvidersSnapshot(input: {
  client: SnapshotClient;
  serverId: string;
  cwd: string | null;
  queryClient?: QueryClient;
  cache?: ProviderSnapshotCache;
  signal?: AbortSignal;
  snapshot?: Snapshot;
}): Promise<Snapshot> {
  const cache = input.cache ?? providerSnapshotCache;
  const queryClient = input.queryClient ?? singletonQueryClient;
  const cached = input.snapshot ? null : await cache.read(input.serverId, input.cwd);
  let snapshot =
    input.snapshot ??
    (await input.client.getProvidersSnapshot(
      providersSnapshotRequestOptions({ cwd: input.cwd, ifNoneMatch: cached?.hash }),
    ));
  if (snapshot.snapshotHash && !snapshot.compactSnapshot) {
    const known =
      cached?.hash === snapshot.snapshotHash
        ? cached
        : await cache.readHash(input.serverId, snapshot.snapshotHash);
    if (known) snapshot = { ...snapshot, compactSnapshot: known.compactSnapshot };
    else if (snapshot.notModified) throw new ProviderSnapshotCacheMissError();
    else {
      const hash = snapshot.snapshotHash;
      const body = await queryClient.fetchQuery({
        queryKey: ["providerSnapshotContent", input.serverId, hash],
        gcTime: 0,
        structuralSharing: false,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          const response = await input.client.getProvidersSnapshot(
            providersSnapshotRequestOptions({ cwd: input.cwd }),
          );
          // Materialize before settling so simultaneous directory announcements share
          // both the transfer and decoded body through the existing query deduplication.
          return cache.materialize(input.serverId, response);
        },
      });
      if (body.snapshotHash === hash) {
        snapshot = { ...snapshot, compactSnapshot: body.compactSnapshot };
      } else if (normalizeProvidersSnapshotCwd(body.cwd) === input.cwd) {
        snapshot = body;
      } else {
        snapshot = await input.client.getProvidersSnapshot(
          providersSnapshotRequestOptions({ cwd: input.cwd }),
        );
      }
    }
  }
  if (input.signal?.aborted) throw new CancelledError();
  snapshot = await cache.materialize(input.serverId, snapshot);
  if (snapshot.compactSnapshot && snapshot.snapshotHash) {
    await cache.write({
      serverId: input.serverId,
      cwd: input.cwd,
      hash: snapshot.snapshotHash,
      generatedAt: snapshot.generatedAt,
      fetchedAt: snapshot.fetchedAt,
      compactSnapshot: snapshot.compactSnapshot,
      signal: input.signal,
    });
  }
  if (input.signal?.aborted) throw new CancelledError();
  replaceProviderSnapshotIcons(input.serverId, snapshot.entries);
  return snapshot;
}

export async function refreshAndApplyProvidersSnapshot(input: {
  client: SnapshotClient & Pick<DaemonClient, "refreshProvidersSnapshot">;
  queryClient: QueryClient;
  serverId: string;
  cwd: string | null;
  providers?: AgentProvider[];
  cache?: ProviderSnapshotCache;
}) {
  const result = await input.client.refreshProvidersSnapshot(
    providersSnapshotRequestOptions(input),
  );
  const queryKey = providersSnapshotQueryKey(input.serverId, input.cwd);
  await input.queryClient.cancelQueries({ queryKey, exact: true });
  await input.queryClient.fetchQuery({
    queryKey,
    staleTime: 0,
    structuralSharing: false,
    queryFn: ({ signal }) => fetchProvidersSnapshot({ ...input, signal }),
  });
  void input.queryClient.invalidateQueries({
    queryKey: agentCommandsQueryRoot(input.serverId),
    exact: false,
  });
  if (isProvidersSnapshotHomeScope(input.cwd)) {
    void input.queryClient.invalidateQueries({
      queryKey: providersSnapshotQueryRoot(input.serverId),
      exact: false,
    });
  }
  return result;
}
