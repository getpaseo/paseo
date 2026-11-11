import type { ReactElement } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Folder, FolderPlus, GitBranch, GitPullRequest } from "lucide-react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";

const ThemedFolder = withUnistyles(Folder);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const folderIcon = <ThemedFolder size={ICON_SIZE.sm} uniProps={mutedColor} />;
export const addProjectIcon = <ThemedFolderPlus size={ICON_SIZE.sm} uniProps={mutedColor} />;
export const branchIcon = <ThemedGitBranch size={ICON_SIZE.sm} uniProps={mutedColor} />;
export const pullRequestIcon = <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={mutedColor} />;

// Single uppercase initial inside an iconSize.md (16px) square — below the smallest font-size
// token, so it stays a literal sized to the box.
const PROJECT_ICON_FALLBACK_FONT_SIZE = 10;

export function ProjectIcon({
  projectViewKey,
  projectName,
  iconDataUri,
}: {
  projectViewKey: string;
  projectName: string;
  iconDataUri: string | null;
}): ReactElement {
  const placeholderLabel = projectIconPlaceholderLabelFromDisplayName(projectName);
  return (
    <ProjectIconView
      iconDataUri={iconDataUri}
      initial={placeholderLabel.charAt(0).toUpperCase() || "?"}
      projectViewKey={projectViewKey}
      size={ICON_SIZE.md}
      textStyle={styles.fallbackText}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  fallbackText: {
    fontSize: PROJECT_ICON_FALLBACK_FONT_SIZE,
    fontWeight: theme.fontWeight.semibold,
  },
}));
