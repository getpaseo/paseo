import { SquarePen } from "lucide-react-native";
import { useCallback } from "react";
import invariant from "tiny-invariant";
import { WorkspaceDraftAgentTab } from "@/screens/workspace/workspace-draft-agent-tab";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

function useDraftPanelDescriptor() {
  return {
    label: "New Agent",
    subtitle: "New Agent",
    titleState: "ready" as const,
    icon: SquarePen,
    statusBucket: null,
  };
}

function DraftPanel() {
  const {
    serverId,
    workspaceId,
    tabId,
    target,
    openFileInWorkspace,
    openImportSheet,
    retargetCurrentTab,
  } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  invariant(target.kind === "draft", "DraftPanel requires draft target");

  const handleOpenWorkspaceFile = useCallback(
    ({ filePath }: { filePath: string }) => {
      openFileInWorkspace(filePath);
    },
    [openFileInWorkspace],
  );

  const handleCreated = useCallback(
    (agentSnapshot: Parameters<typeof normalizeAgentSnapshot>[0]) => {
      const normalized = normalizeAgentSnapshot(agentSnapshot, serverId);
      retargetCurrentTab({ kind: "agent", agentId: agentSnapshot.id });
      useSessionStore.getState().setAgents(serverId, (prev) => {
        const next = new Map(prev);
        next.set(agentSnapshot.id, normalized);
        return next;
      });
    },
    [retargetCurrentTab, serverId],
  );

  return (
    <WorkspaceDraftAgentTab
      serverId={serverId}
      workspaceId={workspaceId}
      tabId={tabId}
      draftId={target.draftId}
      isPaneFocused={isInteractive}
      onOpenWorkspaceFile={handleOpenWorkspaceFile}
      onCreated={handleCreated}
      onOpenImportSheet={openImportSheet}
    />
  );
}

export const draftPanelRegistration: PanelRegistration<"draft"> = {
  kind: "draft",
  component: DraftPanel,
  useDescriptor: useDraftPanelDescriptor,
};
