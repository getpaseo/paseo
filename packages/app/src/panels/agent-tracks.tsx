import { memo, useCallback, type ReactElement } from "react";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openSupportingTab } from "@/workspace-tabs/side-panel";

/**
 * The pane's trackers — its subagents and its task list — as a row of pills above the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Its data remains agent state: a subagent row opens a tab and the task list reads
 * the agent's stream.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
}: {
  serverId: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
}): ReactElement | null {
  const { workspaceId, tabId, openTab } = usePaneContext();
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePanelByDefault = useSettings(
    (settings) => settings.openSupportingTabsInSidePanel,
  );
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId: subagentId });
        return;
      }
      if (canSplit && workspaceKey) {
        openSupportingTab({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId: subagentId },
          openInSidePanelByDefault,
          parentTabId: tabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [canSplit, isCompact, openInSidePanelByDefault, serverId, tabId, workspaceId, workspaceKey],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (canSplit && workspaceKey) {
        openSupportingTab({
          isCompact,
          workspaceKey,
          target: { kind: "provider_subagent", parentAgentId, subagentId },
          openInSidePanelByDefault,
          parentTabId: tabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePanelByDefault, openTab, tabId, workspaceKey],
  );

  if (!hasAgentTracks({ subagentRows, tasks, archiveFinishedStatus })) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <AgentTaskList tasks={tasks} />
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  archiveFinishedStatus,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
}): boolean {
  return subagentRows.length > 0 || Boolean(tasks?.length) || archiveFinishedStatus.kind !== "idle";
}
