import type { ReactElement } from "react";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useWorkspaceFileActions, WorkspaceFileActionItems } from "@/workspace/file-actions";

/** The file rows of a file tab's menu, or null for every other kind of tab. */
export function useFileTabMenu({
  serverId,
  workspaceId,
  tab,
  testIDBase,
  onRevealInFiles,
}: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabDescriptor;
  testIDBase: string;
  /** Close whatever covers the Explorer before it opens. */
  onRevealInFiles?: () => void;
}): ReactElement | null {
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const fileActions = useWorkspaceFileActions({
    serverId,
    workspaceId,
    workspaceRoot,
    onRevealInFiles,
  });
  if (tab.target.kind !== "file") return null;
  return (
    <WorkspaceFileActionItems
      actions={fileActions.actionsFor(tab.target.path, "file")}
      revealTargetName={fileActions.revealTargetName}
      testIDBase={testIDBase}
    />
  );
}
