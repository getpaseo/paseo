import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  type SubagentTreeNode,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openSupportingTab, toggleSupportingTab } from "@/workspace-tabs/side-panel";
import { confirmDialog } from "@/utils/confirm-dialog";

/**
 * The pane's ambient context — workspace changes, subagents, and tasks — as a row of pills above
 * the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  cwd,
  subagentRows,
  subagentTree,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  subagentRows: SubagentRow[];
  subagentTree?: SubagentTreeNode[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const { tabId, openTab } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
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
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeManagedSubagentIds = useMemo(
    () =>
      subagentRows
        .filter((row) => row.kind === "paseo" && row.status === "running")
        .map((row) => row.id),
    [subagentRows],
  );
  const handleStopSubagent = useCallback(
    (agentId: string) => {
      if (!client) return;
      void client.cancelAgent(agentId).catch(() => undefined);
    },
    [client],
  );
  const handleStopAllActive = useCallback(async () => {
    if (!client || activeManagedSubagentIds.length === 0) return;
    const names = subagentRows
      .filter((row) => activeManagedSubagentIds.includes(row.id))
      .map((row) => row.title)
      .join(", ");
    const confirmed = await confirmDialog({
      title: t("subagents.stopAllConfirmTitle"),
      message: t("subagents.stopAllConfirmMessage", {
        count: activeManagedSubagentIds.length,
        names,
      }),
      confirmLabel: t("subagents.stopAllAction"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    await Promise.all(activeManagedSubagentIds.map((agentId) => client.cancelAgent(agentId)));
  }, [activeManagedSubagentIds, client, subagentRows, t]);
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
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) {
      return;
    }
    toggleSupportingTab({
      isCompact,
      workspaceKey,
      checkout: { serverId, cwd, isGit: true },
      target: { kind: "working_diff" },
      openInSidePanelByDefault,
    });
  }, [cwd, isCompact, openInSidePanelByDefault, serverId, workspaceKey]);

  if (!hasWorkspaceDiffStat && !hasAgentTracks({ subagentRows, tasks, archiveFinishedStatus })) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <AgentTaskList tasks={tasks} />
      <SubagentsTrack
        serverId={serverId}
        rows={subagentRows}
        tree={subagentTree}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
        onStopSubagent={handleStopSubagent}
        onStopAllActive={activeManagedSubagentIds.length > 0 ? handleStopAllActive : undefined}
      />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={workspaceId}
        onPress={handleOpenChanges}
      />
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
