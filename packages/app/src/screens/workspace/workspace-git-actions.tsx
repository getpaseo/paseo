import { useMemo } from "react";
import { useUnistyles } from "react-native-unistyles";
import {
  Archive,
  Download,
  GitCommitHorizontal,
  GitMerge,
  RefreshCcw,
  Upload,
} from "lucide-react-native";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitActionsSplitButton } from "@/components/git-actions-split-button";
import { useGitActions } from "@/hooks/use-git-actions";

interface WorkspaceGitActionsProps {
  serverId: string;
  cwd: string;
  hideLabels?: boolean;
}

export function WorkspaceGitActions({ serverId, cwd, hideLabels }: WorkspaceGitActionsProps) {
  const { theme } = useUnistyles();

  const icons = useMemo(
    () => ({
      commit: <GitCommitHorizontal size={16} color={theme.colors.foregroundMuted} />,
      pull: <Download size={16} color={theme.colors.foregroundMuted} />,
      push: <Upload size={16} color={theme.colors.foregroundMuted} />,
      viewPr: <GitHubIcon size={16} color={theme.colors.foregroundMuted} />,
      createPr: <GitHubIcon size={16} color={theme.colors.foregroundMuted} />,
      merge: <GitMerge size={16} color={theme.colors.foregroundMuted} />,
      mergeFromBase: <RefreshCcw size={16} color={theme.colors.foregroundMuted} />,
      archive: <Archive size={16} color={theme.colors.foregroundMuted} />,
    }),
    [theme.colors.foregroundMuted],
  );

  const { gitActions, isGit } = useGitActions({ serverId, cwd, icons });

  if (!isGit) {
    return null;
  }

  return <GitActionsSplitButton gitActions={gitActions} hideLabels={hideLabels} />;
}
