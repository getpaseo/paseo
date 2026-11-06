import { ComposerDockBackground } from "@/composer/dock";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { TOUCH_TARGET } from "@/components/ui/control-sizing";
import { useTopBandRow } from "@/window-layout";

// Leading content that must stay readable in the top band: a navigation button and a title.
const MIN_LEADING_WIDTH = TOUCH_TARGET + 8 + 96;

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  left,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const baseHorizontalPadding = isMobile ? theme.spacing[2] : theme.spacing[3];

  const [rightWidth, setRightWidth] = useState(0);
  const measureRight = useCallback(
    (event: LayoutChangeEvent) => setRightWidth(event.nativeEvent.layout.width),
    [],
  );
  const topBand = useTopBandRow({
    offset: insets.top + topPadding,
    height: isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT,
    minimumWidth: baseHorizontalPadding + MIN_LEADING_WIDTH + rightWidth,
  });
  const innerStyle = useMemo(
    () => [styles.inner, { paddingTop: insets.top + topPadding + topBand.top }],
    [insets.top, topPadding, topBand.top],
  );
  const rowStyle = useMemo(() => [styles.row, borderless && styles.borderless], [borderless]);
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  // The occlusion replaces the row's trailing padding rather than adding to it.
  const rightCombinedStyle = useMemo(
    () => [
      styles.right,
      rightStyle,
      topBand.trailing > baseHorizontalPadding && {
        marginRight: topBand.trailing - baseHorizontalPadding,
      },
    ],
    [rightStyle, topBand.trailing, baseHorizontalPadding],
  );

  return (
    <ComposerDockBackground style={styles.header} testID="composer-dock-header">
      <View ref={topBand.ref} onLayout={topBand.onLayout} style={innerStyle}>
        <WindowChromeSafeArea
          placement="inline"
          horizontalPadding={baseHorizontalPadding}
          onLayout={onRowLayout}
          style={rowStyle}
        >
          <TitlebarDragRegion />
          <View style={leftCombinedStyle}>{left}</View>
          <View style={rightCombinedStyle} onLayout={measureRight}>
            {right}
          </View>
        </WindowChromeSafeArea>
      </View>
    </ComposerDockBackground>
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
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
}));
