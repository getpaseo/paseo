import type { ChangeBreakdown } from "@getpaseo/protocol/diff-stat";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { ChangeStats } from "@/components/change-stats";
import { composerPillStyles } from "@/composer/pill-styles";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  breakdown?: ChangeBreakdown;
  serverId?: string;
  onPress: () => void;
}

export function ComposerDiffStatPill({
  additions,
  deletions,
  breakdown,
  serverId,
  onPress,
}: ComposerDiffStatPillProps) {
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
      <ChangeStats
        additions={additions}
        deletions={deletions}
        breakdown={breakdown}
        serverId={serverId}
      />
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
  return <ComposerDiffStatPill {...diffStat} serverId={serverId} onPress={onPress} />;
});
