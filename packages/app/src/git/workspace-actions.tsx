import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";

interface WorkspaceActionsProps {
  serverId: string;
  workspaceId: string;
  cwd: string;
}

export function WorkspaceActions({ serverId, workspaceId, cwd }: WorkspaceActionsProps) {
  const { gitActions, watchDialog } = useGitActions({
    serverId,
    workspaceId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return (
    <>
      <GitActionsSplitButton gitActions={gitActions} />
      {watchDialog}
    </>
  );
}
