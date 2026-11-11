import { useCallback, useId } from "react";
import type { LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const EDGE_EPSILON = 1;
const SHADE_WIDTH = 24;

function ScrollBoundaryShadeSvg({ side, color }: { side: "left" | "right"; color: string }) {
  const gradientId = `horizontal-scroll-boundary-${side}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient
          id={gradientId}
          x1={side === "left" ? "100%" : "0%"}
          y1="0%"
          x2={side === "left" ? "0%" : "100%"}
          y2="0%"
        >
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedScrollBoundaryShadeSvg = withUnistyles(ScrollBoundaryShadeSvg);
const surfaceColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const sidebarColorMapping = (theme: Theme) => ({ color: theme.colors.surfaceSidebar });

export function useHorizontalScrollBoundary() {
  const offset = useSharedValue(0);
  const viewportWidth = useSharedValue(0);
  const contentWidth = useSharedValue(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidth.value = event.nativeEvent.layout.width;
    },
    [viewportWidth],
  );
  const onContentSizeChange = useCallback(
    (width: number) => {
      contentWidth.value = width;
    },
    [contentWidth],
  );
  const onScroll = useAnimatedScrollHandler((event) => {
    offset.value = event.contentOffset.x;
    viewportWidth.value = event.layoutMeasurement.width;
    contentWidth.value = event.contentSize.width;
  });
  const leftShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(offset.value > EDGE_EPSILON),
  }));
  const rightShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(offset.value + viewportWidth.value < contentWidth.value - EDGE_EPSILON),
  }));
  return { onLayout, onContentSizeChange, onScroll, leftShadeStyle, rightShadeStyle };
}

export function HorizontalScrollBoundaryShades({
  visible,
  backdrop,
  leftStyle,
  rightStyle,
  testIDPrefix = "horizontal-scroll-boundary",
}: {
  visible: boolean;
  backdrop: "surface" | "sidebar";
  leftStyle: AnimatedStyle<{ opacity: number }>;
  rightStyle: AnimatedStyle<{ opacity: number }>;
  testIDPrefix?: string;
}) {
  if (!visible) return null;
  const colorMapping = backdrop === "sidebar" ? sidebarColorMapping : surfaceColorMapping;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        testID={`${testIDPrefix}-left`}
        style={[styles.shade, styles.left, leftStyle]}
      >
        <ThemedScrollBoundaryShadeSvg side="left" uniProps={colorMapping} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        testID={`${testIDPrefix}-right`}
        style={[styles.shade, styles.right, rightStyle]}
      >
        <ThemedScrollBoundaryShadeSvg side="right" uniProps={colorMapping} />
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create(() => ({
  shade: {
    position: "absolute",
    top: 0,
    bottom: 1,
    width: SHADE_WIDTH,
  },
  left: { left: 0 },
  right: { right: 0 },
}));
