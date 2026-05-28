import { withUnistyles } from "react-native-unistyles";
import {
  Archive,
  ArrowDownUp,
  Download,
  GitCommitHorizontal,
  GitMerge,
  RefreshCcw,
  Upload,
} from "lucide-react-native";
import { GitHubIcon } from "@/components/icons/github-icon";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { useGitActions } from "@/git/use-actions";
import type { Theme } from "@/styles/theme";

interface WorkspaceGitActionsProps {
  serverId: string;
  cwd: string;
  hideLabels?: boolean;
}

const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);
const ThemedDownload = withUnistyles(Download);
const ThemedUpload = withUnistyles(Upload);
const ThemedArrowDownUp = withUnistyles(ArrowDownUp);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const ThemedGitMerge = withUnistyles(GitMerge);
const ThemedRefreshCcw = withUnistyles(RefreshCcw);
const ThemedArchive = withUnistyles(Archive);

const mutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ICONS = {
  commit: <ThemedGitCommitHorizontal size={16} uniProps={mutedColorMapping} />,
  pull: <ThemedDownload size={16} uniProps={mutedColorMapping} />,
  push: <ThemedUpload size={16} uniProps={mutedColorMapping} />,
  pullAndPush: <ThemedArrowDownUp size={16} uniProps={mutedColorMapping} />,
  viewPr: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
  createPr: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
  mergePrSquash: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
  mergePrMerge: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
  mergePrRebase: <ThemedGitHubIcon size={16} uniProps={mutedColorMapping} />,
  merge: <ThemedGitMerge size={16} uniProps={mutedColorMapping} />,
  mergeFromBase: <ThemedRefreshCcw size={16} uniProps={mutedColorMapping} />,
  archive: <ThemedArchive size={16} uniProps={mutedColorMapping} />,
};

export function WorkspaceGitActions({ serverId, cwd, hideLabels }: WorkspaceGitActionsProps) {
  const { gitActions, isGit } = useGitActions({ serverId, cwd, icons: ICONS });

  if (!isGit) {
    return null;
  }

  return <GitActionsSplitButton gitActions={gitActions} hideLabels={hideLabels} />;
}
