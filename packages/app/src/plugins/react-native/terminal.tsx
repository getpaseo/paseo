import { useCallback } from "react";
import type { TerminalViewProps } from "@getpaseo/plugin/client/ui";
import { TerminalPane } from "@/components/terminal-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { showExplorerSidebar } from "@/workspace-tabs/explorer-sidebar";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/** The containing panel owns placement and focus; the daemon owns the terminal process. */
export function TerminalView({ terminalId, cwd, appearance }: TerminalViewProps) {
  const { serverId, workspaceId, openFileInWorkspace } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused } = usePaneFocus();
  const isCompact = useIsCompactFormFactor();
  const openExplorer = useCallback(() => {
    showExplorerSidebar({
      isCompact,
      workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
    });
  }, [isCompact, serverId, workspaceId]);

  return (
    <TerminalPane
      serverId={serverId}
      cwd={cwd}
      terminalId={terminalId}
      appearance={appearance}
      isWorkspaceFocused={isWorkspaceFocused}
      isPaneFocused={isPaneFocused}
      onOpenFileExplorer={openExplorer}
      onOpenWorkspaceFile={openFileInWorkspace}
    />
  );
}
