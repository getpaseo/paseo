import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp, GitBranch, GitCommitHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const accentColorMapping = (theme: Theme) => ({
  color: theme.colors.accent,
});
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);

/**
 * Header row for a branch group inside a project. The parent/primary checkout group is
 * visually distinct: it carries a "commit" icon instead of a branch icon and an accent label.
 * Collapse behavior mirrors the status-group headers.
 */
export function SidebarBranchGroupRow({
  label,
  isParent,
  collapsed,
  onToggleCollapsed,
  testID,
}: {
  label: string;
  isParent: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  testID: string;
}) {
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && !pressed && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  const Icon = isParent ? ThemedGitCommitHorizontal : ThemedGitBranch;
  return (
    <Pressable
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={label}
      onPress={onToggleCollapsed}
      style={rowStyle}
      testID={testID}
    >
      {({ hovered, pressed }) => {
        const iconActive = hovered || pressed;
        let iconUniProps: (theme: Theme) => { color: string };
        let textStyle;
        if (isParent) {
          iconUniProps = accentColorMapping;
          textStyle = iconActive ? styles.textParentHovered : styles.textParent;
        } else {
          iconUniProps = iconActive ? foregroundColorMapping : foregroundMutedColorMapping;
          textStyle = iconActive ? styles.textHovered : styles.text;
        }
        return (
          <>
            <View style={styles.iconSlot}>
              {collapsed ? (
                <ThemedChevronDown
                  size={14}
                  uniProps={iconActive ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              ) : (
                <ThemedChevronUp
                  size={14}
                  uniProps={iconActive ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </View>
            <Icon size={14} uniProps={iconUniProps} />
            <Text numberOfLines={1} style={textStyle}>
              {label}
            </Text>
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingLeft: 16,
    paddingRight: 12,
    borderRadius: 4,
    marginRight: 8,
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: 14,
    alignItems: "center",
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 12,
  },
  textHovered: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
  },
  textParent: {
    flex: 1,
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  textParentHovered: {
    flex: 1,
    color: theme.colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
}));
