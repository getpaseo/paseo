import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  isCompactFormFactor,
} from "@/constants/layout";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({ left, right, leftStyle, rightStyle, borderless }: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = isCompactFormFactor();
  const padding = useWindowControlsPadding("header");
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const baseHorizontalPadding = theme.spacing[2];

  return (
    <View style={styles.header}>
      <View style={[styles.inner, { paddingTop: insets.top + topPadding }]}>
        <View
          style={[
            styles.row,
            {
              paddingLeft: baseHorizontalPadding + padding.left,
              paddingRight: baseHorizontalPadding + padding.right,
            },
            borderless && styles.borderless,
          ]}
        >
          <TitlebarDragRegion />
          <View style={[styles.left, leftStyle]}>{left}</View>
          <View style={[styles.right, rightStyle]}>{right}</View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  inner: {},
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
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
  borderless: {
    borderBottomColor: "transparent",
  },
}));
