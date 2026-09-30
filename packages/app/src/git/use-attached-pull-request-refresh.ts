import { useEffect } from "react";
import { pullRequestCurationStore } from "@/git/pull-request-curation-store";
import { refreshAttachedPullRequests } from "@/git/use-attach-pull-request";
import type { RelatedPullRequest } from "@/git/related-pull-requests";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const ATTACHED_REFRESH_INTERVAL_MS = 5 * 60_000;
const attachedRefreshedAt = new Map<string, number>();

/** Sends the workspace's set decisions, with the facts this client holds, to the daemon. */
export function persistWorkspaceCuration(
  client: Pick<DaemonClient, "curateWorkspacePullRequests"> | null,
  workspaceId: string,
  workspaceKey: string,
): void {
  if (!client) return;
  void client
    .curateWorkspacePullRequests(
      workspaceId,
      pullRequestCurationStore.getCuration(workspaceKey),
      pullRequestCurationStore.getFacts(workspaceKey),
    )
    .catch(() => {
      // The set still reads correctly from the cache; the daemon rejects loudly enough in its
      // own log, and nothing here is worth interrupting the view for.
    });
}

/**
 * Rereads attached pull requests that still read open, so a merge shows everywhere once stored.
 * The daemon keeps an attached number's facts as they were when it was attached, so without a
 * client asking again a merged stack reads "0/11 merged" forever.
 */
export function useAttachedPullRequestRefresh(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  pullRequests: readonly RelatedPullRequest[];
}): void {
  const { serverId, workspaceId, workspaceKey, pullRequests } = input;
  const client = useHostRuntimeClient(serverId);
  const workspace = useWorkspace(serverId, workspaceId);
  const persisted = workspace?.pullRequestCuration;
  const cwd = workspace?.workspaceDirectory ?? null;
  const openAttached = pullRequests
    .filter((pullRequest) => pullRequest.origin === "manual" && pullRequest.state === "open")
    .map((pullRequest) => pullRequest.number)
    .join(",");

  useEffect(() => {
    // Without the stored decisions the write below would replace the set with the few
    // numbers this refresh touched.
    if (!client || !cwd || !openAttached || !persisted) return;
    const now = Date.now();
    if (now - (attachedRefreshedAt.get(workspaceKey) ?? 0) < ATTACHED_REFRESH_INTERVAL_MS) return;
    attachedRefreshedAt.set(workspaceKey, now);
    pullRequestCurationStore.hydrate(workspaceKey, persisted);
    void refreshAttachedPullRequests({
      client: { searchForge: (options) => client.searchForge(options) },
      cwd,
      workspaceKey,
      pullRequests,
    }).then((changed) => {
      if (changed > 0) persistWorkspaceCuration(client, workspaceId, workspaceKey);
      return undefined;
    });
  }, [client, cwd, openAttached, persisted, pullRequests, workspaceId, workspaceKey]);
}
