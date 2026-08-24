import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { sidebarWorkspaceRowStyles } from "@/components/sidebar/sidebar-workspace-row-content";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

/**
 * The row that ends a truncated group. It is a workspace row that happens to say "Show more", so
 * it takes the workspace row's geometry — height, padding, radius, and both fills — rather than a
 * set of its own. Sitting under a column of rows, anything it does differently reads as a mistake
 * rather than as a distinction.
 *
 * `indented` because the two groupings disagree: status rows sit on their header's label rail and
 * project rows sit flush, so the caller says which list this row is ending. The indent itself is
 * the workspace row's, imported rather than re-derived.
 */
export function SidebarGroupToggleRow({
  expanded,
  onPress,
  indented = false,
  testID,
}: {
  expanded: boolean;
  onPress: () => void;
  indented?: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  const label = t(
    expanded ? "sidebar.workspace.actions.showLess" : "sidebar.workspace.actions.showMore",
  );
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      indented && sidebarWorkspaceRowStyles.rowIndented,
      hovered && !pressed && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [indented],
  );

  return (
    <Pressable
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={label}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      {({ hovered, pressed }) => (
        <>
          <View style={styles.iconSlot}>
            {expanded ? (
              <ThemedChevronUp
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            ) : (
              <ThemedChevronDown
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </View>
          <Text style={hovered || pressed ? styles.textHovered : styles.text} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Kept in step with `workspaceRow` in sidebar-workspace-list.tsx and sidebar-status-list.tsx.
  row: {
    minHeight: 36,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // The width of a workspace row's status slot, so the label lands on the same rail as the
  // titles above it rather than two points to their left.
  iconSlot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
  textHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
}));
