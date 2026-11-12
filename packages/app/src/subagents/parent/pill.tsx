import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composerPillStyles } from "@/composer/pill-styles";
import { ComposerTrackMark } from "@/composer/tracks";
import type { Theme } from "@/styles/theme";
import { useParentAgent } from "./use-parent-agent";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * The way back from a subagent to the agent that started it. It leads the pill rail and names
 * the parent rather than saying "parent": in a stack of subagents the title is what tells you
 * where you will land.
 */
export function ParentAgentPill({
  serverId,
  parentAgentId,
}: {
  serverId: string;
  parentAgentId: string;
}): ReactElement {
  const { t } = useTranslation();
  const parent = useParentAgent(serverId, parentAgentId);
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, styles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, styles.label, isHovered && composerPillStyles.labelActive],
    [isHovered],
  );
  const label = parent.label ?? t("subagents.parent.backToParent");

  return (
    <PressHighlight
      testID="composer-parent-agent-pill"
      accessibilityRole="button"
      accessibilityLabel={t("subagents.parent.backTo", { label })}
      onPress={parent.open}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <ThemedChevronLeft
        size={14}
        uniProps={isHovered ? foregroundColorMapping : mutedColorMapping}
      />
      <ComposerTrackMark bucket={parent.statusBucket} />
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The chevron's box is wider than its stroke, so the pill pulls it toward the edge to keep the
  // visible glyph on the same inset as other pills' leading marks.
  body: {
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    maxWidth: { xs: 140, md: 240 },
  },
}));
