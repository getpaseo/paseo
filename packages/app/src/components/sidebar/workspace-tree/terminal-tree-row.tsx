import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import { buildTerminalRowPresentation, buildTerminalRowTarget } from "./row-presentation";
import type { ActiveTreeTab } from "./use-active-tree-tab";
import { WorkspaceTreeRow } from "./tree-row";

interface TerminalTreeRowProps {
  terminalId: string;
  name: string;
  title: string | null;
  activity: TerminalActivity | null;
  /** Supplied by the caller so terminals share one depth source with agents. */
  depth: number;
  serverId: string;
  workspaceId: string;
  /** The tab currently being viewed on this server, or null. */
  activeTab: ActiveTreeTab | null;
  onWorkspacePress?: () => void;
}

export const TerminalTreeRow = memo(function TerminalTreeRow({
  terminalId,
  name,
  title,
  activity,
  depth,
  serverId,
  workspaceId,
  activeTab,
  onWorkspacePress,
}: TerminalTreeRowProps) {
  const { t } = useTranslation();
  const label = title?.trim() || name.trim() || t("workspace.tabs.fallback.terminal");

  // One target drives both navigation and the active-row check.
  const target = useMemo(() => buildTerminalRowTarget(terminalId), [terminalId]);
  // Terminals belong to the workspace that created them, so no fallback here.
  const selected =
    activeTab !== null &&
    activeTab.workspaceId === workspaceId &&
    activeTab.tabId === buildDeterministicWorkspaceTabId(target);

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({ serverId, workspaceId, target });
  }, [onWorkspacePress, serverId, workspaceId, target]);

  const presentation = useMemo(
    () => buildTerminalRowPresentation({ terminalId, label, activity }),
    [activity, label, terminalId],
  );

  return (
    <WorkspaceTreeRow
      depth={depth}
      presentation={presentation}
      label={label}
      onPress={handleNavigate}
      selected={selected}
    />
  );
});
