import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({ left, right, leftStyle, rightStyle }: ScreenHeaderProps) {
  const insets = useSafeAreaInsets();
  const isMobile = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? 8 : 0;

  return (
    <View style={styles.header}>
      <View style={[styles.inner, { paddingTop: insets.top + topPadding }]}>
        <View style={styles.row}>
          <View style={[styles.left, leftStyle]}>{left}</View>
          <View style={[styles.right, rightStyle]}>{right}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.background,
  },
  inner: {},
  row: {
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
