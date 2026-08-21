import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";

/** Shared chrome at the boundary between a workspace pane's tabs and content. */
export function PaneContentToolbar({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <View style={[styles.toolbar, style]} testID={testID}>
      {children}
    </View>
  );
}

export function paneContentToolbarIconSize(isCompact: boolean): number {
  return isCompact ? 18 : 14;
}

export function paneContentToolbarIconButtonStyle(
  { hovered, pressed }: { hovered?: boolean; pressed: boolean },
  selected = false,
  isCompact = false,
) {
  return [
    isCompact ? styles.iconButtonCompact : styles.iconButton,
    (selected || Boolean(hovered) || pressed) && styles.iconButtonSelected,
  ];
}

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    flexShrink: 0,
  },
  iconButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  iconButtonCompact: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  iconButtonSelected: {
    backgroundColor: theme.colors.surface2,
  },
}));
