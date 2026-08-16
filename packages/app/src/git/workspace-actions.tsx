import { GitActionsSplitButton } from "@/git/actions-split-button";
import { useGitActions } from "@/git/use-actions";
import { GIT_ACTION_ICONS } from "@/git/action-icons";

interface WorkspaceActionsProps {
  serverId: string;
  workspaceId: string;
  cwd: string;
  isWorkspaceGitBound: boolean;
  hideLabels?: boolean;
}

function BoundWorkspaceActions({ serverId, cwd, hideLabels }: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return <GitActionsSplitButton gitActions={gitActions} hideLabels={hideLabels} />;
}

export function WorkspaceActions(props: WorkspaceActionsProps) {
  return props.isWorkspaceGitBound ? <BoundWorkspaceActions {...props} /> : null;
}
