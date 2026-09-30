import { useCallback, useEffect, useMemo, useState } from "react";
import { useAttachPullRequestDialog } from "@/git/use-attach-pull-request-dialog";
import { attachScannedPullRequests, useScanWorkspaceChat } from "@/git/use-scan-workspace-chat";
import { ScanChatDialog, type ScanChatFinding } from "@/git/scan-chat-dialog";
import {
  pullRequestCurationStore,
  usePullRequestCuration,
} from "@/git/pull-request-curation-store";
import { applyPullRequestCuration } from "@/git/pull-request-curation";
import {
  persistWorkspaceCuration,
  useAttachedPullRequestRefresh,
} from "@/git/use-attached-pull-request-refresh";
import type { RelatedPullRequest } from "@/git/related-pull-requests";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import { ChangeRequestSetList } from "./change-request-set";

/**
 * The expanded set with its two ways of growing wired up, and with what the user decides about
 * it kept where it survives a restart.
 *
 * Attaching and scanning both need a host to ask, so they live in this thin shell rather than in
 * the meta row — a row whose workspace has no server keeps rendering the plain list and nothing
 * breaks. The decisions go to the daemon, which stores them on the workspace record and hands
 * them back in its snapshot; the store here is the write-through cache in between.
 */
export function ManagedChangeRequestSetList({
  serverId,
  workspaceId,
  workspaceKey,
  pullRequests,
  onRemovePullRequest,
}: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  pullRequests: readonly RelatedPullRequest[];
  onRemovePullRequest: (number: number) => void;
}) {
  const { attachDialog, openAttachDialog } = useAttachPullRequestDialog({
    serverId,
    workspaceId,
    workspaceKey,
  });
  const { scanChat, scanning } = useScanWorkspaceChat({
    serverId,
    workspaceId,
    workspaceKey,
    pullRequests,
  });
  const [scanResult, setScanResult] = useState<{
    findings: ScanChatFinding[];
    unresolved: number[];
  } | null>(null);
  const client = useHostRuntimeClient(serverId);
  const workspace = useWorkspace(serverId, workspaceId);
  const persisted = workspace?.pullRequestCuration;
  const { curation, facts } = usePullRequestCuration(workspaceKey);

  // What attach and scan resolved lives in the store; without this the row
  // renders the daemon's own list alone and every attachment vanishes on the
  // way to the screen.
  const shownPullRequests = useMemo(
    () => applyPullRequestCuration(pullRequests, facts, curation),
    [pullRequests, facts, curation],
  );

  // What the daemon stored wins on arrival, which is what makes a set assembled yesterday be
  // there today. Identical decisions change nothing, so the echo of our own write stops here.
  useEffect(() => {
    pullRequestCurationStore.hydrate(workspaceKey, persisted);
  }, [workspaceKey, persisted]);

  // The facts go with the decision. The daemon cannot draw a bare number, so a
  // set sent without them comes back empty on the next client that asks.
  const persistCuration = useCallback(
    () => persistWorkspaceCuration(client, workspaceId, workspaceKey),
    [client, workspaceId, workspaceKey],
  );

  useAttachedPullRequestRefresh({ serverId, workspaceId, workspaceKey, pullRequests });

  const handleRemove = useCallback(
    (number: number) => {
      onRemovePullRequest(number);
      persistCuration();
    },
    [onRemovePullRequest, persistCuration],
  );

  const handleScanChat = useCallback(() => {
    void scanChat().then(setScanResult);
  }, [scanChat]);

  const closeScanResult = useCallback(() => setScanResult(null), []);

  const handleAttachScanned = useCallback(
    (chosen: RelatedPullRequest[]) => {
      attachScannedPullRequests(workspaceKey, chosen);
      persistCuration();
    },
    [persistCuration, workspaceKey],
  );

  // The attach dialog writes into the store on its own, so the decisions are followed rather
  // than intercepted: whatever lands there is what gets stored.
  const added = curation.added.join(",");
  useEffect(() => {
    if (added.length > 0) persistCuration();
  }, [added, persistCuration]);

  return (
    <>
      <ChangeRequestSetList
        pullRequests={shownPullRequests}
        onRemovePullRequest={handleRemove}
        onAttachPullRequest={openAttachDialog}
        onScanChat={handleScanChat}
        scanning={scanning}
      />
      {attachDialog}
      {scanResult ? (
        <ScanChatDialog
          findings={scanResult.findings}
          unresolved={scanResult.unresolved}
          onAttach={handleAttachScanned}
          onClose={closeScanResult}
        />
      ) : null}
    </>
  );
}
