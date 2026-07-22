import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

export function SidebarGroupToggleRow({
  expanded,
  onPress,
  testID,
}: {
  expanded: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const label = t(
    expanded ? "sidebar.workspace.actions.showLess" : "sidebar.workspace.actions.showMore",
  );
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && styles.rowHovered,
    ],
    [],
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
  row: {
    minHeight: 32,
    marginLeft: theme.spacing[6],
    marginRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  iconSlot: {
    width: theme.iconSize.sm,
    height: theme.iconSize.sm,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 0,
    flexShrink: 1,
  },
  textHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    minWidth: 0,
    flexShrink: 1,
  },
}));
