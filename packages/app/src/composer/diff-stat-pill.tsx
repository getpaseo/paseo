import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable } from "react-native";
import { FileDiff } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { composerPillStyles } from "@/composer/pill-styles";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedFileDiff = withUnistyles(FileDiff);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  onPress: () => void;
}

export function ComposerDiffStatPill({ additions, deletions, onPress }: ComposerDiffStatPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );

  return (
    <Pressable
      testID="composer-diff-stat-pill"
      accessibilityRole="button"
      accessibilityLabel={t("workspace.git.diff.openChangesTab")}
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      <ThemedFileDiff size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
      <DiffStat additions={additions} deletions={deletions} />
    </Pressable>
  );
}

export const WorkspaceDiffStatPill = memo(function WorkspaceDiffStatPill({
  serverId,
  workspaceId,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
}): ReactElement | null {
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId);
  if (!diffStat) {
    return null;
  }
  return (
    <ComposerDiffStatPill
      additions={diffStat.additions}
      deletions={diffStat.deletions}
      onPress={onPress}
    />
  );
});
