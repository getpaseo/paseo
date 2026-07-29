import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalActivity } from "@getpaseo/protocol/terminal-activity";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildTerminalRowPresentation } from "./row-presentation";
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
  onWorkspacePress,
}: TerminalTreeRowProps) {
  const { t } = useTranslation();
  const label = title?.trim() || name.trim() || t("workspace.tabs.fallback.terminal");

  const handleNavigate = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "terminal", terminalId },
    });
  }, [onWorkspacePress, serverId, workspaceId, terminalId]);

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
    />
  );
});
