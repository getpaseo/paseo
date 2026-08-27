import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
}

export function WorkspaceActions({ serverId, cwd }: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return <GitActionsSplitButton gitActions={gitActions} />;
}
