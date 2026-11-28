import type { ReactNode } from "react";
import { createContext, useMemo } from "react";
import { StyleSheet as RNStyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  resolveSidebarResizeLeadingShift,
  resolveSidebarResizeTrailingShift,
  SIDEBAR_RESIZE_SLAB,
} from "@/components/sidebar-resize-activity";

/**
 * Shared values for a native sidebar drag. The committed layout width stays put until release.
 * `offset` is how far the dragged edge has moved from that width: positive moves it right. The
 * neighboring pane follows `offset` with a transform, and color slabs fill the gap that opens.
 * Layout width is written once, in the same UI frame that returns `offset` to 0.
 */
export interface SidebarResizePreviewValues {
  visible: SharedValue<boolean>;
  offset: SharedValue<number>;
}

export function useSidebarResizePreviewValues(): SidebarResizePreviewValues {
  const visible = useSharedValue(false);
  const offset = useSharedValue(0);
  return useMemo(() => ({ visible, offset }), [visible, offset]);
}

/** The app sidebar's drag. The workspace column reads it and shifts with the finger. */
export const AppSidebarResizePreviewContext = createContext<SidebarResizePreviewValues | null>(
  null,
);

/** Returns the shifted pane to its committed edge. Call it in the same frame as the width write. */
export function hideSidebarResizeShift(shift: SidebarResizePreviewValues): void {
  "worklet";
  shift.offset.value = 0;
  shift.visible.value = false;
}

interface SidebarResizeShiftProps {
  preview: SidebarResizePreviewValues;
  /** Fills the gap on the left when the pane shifts right. */
  leadingFill: string;
  /** Fills the gap on the right when the pane shifts left. */
  trailingFill: string;
  borderColor: string;
  gripColor: string;
  /**
   * `fill` takes the remaining space in a row (the workspace column, a settings detail pane).
   * `shrink` sizes to its child (the explorer dock already has a width; a flex child would eat the row).
   */
  layout: "fill" | "shrink";
  /** Paints over the previous sibling while the pane shifts left across it. */
  coverNeighbor?: boolean;
  children: ReactNode;
}

/**
 * Moves a pane's visible edge with the finger without changing layout width. The pane's content
 * translates. Two childless slabs, moved only by transform, fill the gap that opens on either side.
 * A 1px border and the grip ride on the dragged edge, which is the left edge of this pane.
 */
export function SidebarResizeShift({
  preview,
  leadingFill,
  trailingFill,
  borderColor,
  gripColor,
  layout,
  coverNeighbor,
  children,
}: SidebarResizeShiftProps) {
  const { offset, visible } = preview;
  const leadingStyle = useAnimatedStyle(() => ({
    opacity: visible.value && offset.value > 0 ? 1 : 0,
    transform: [{ translateX: resolveSidebarResizeLeadingShift(offset.value) }],
  }));
  const trailingStyle = useAnimatedStyle(() => ({
    opacity: visible.value && offset.value < 0 ? 1 : 0,
    transform: [{ translateX: resolveSidebarResizeTrailingShift(offset.value) }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: visible.value ? offset.value : 0 }],
  }));
  const chromeStyle = useAnimatedStyle(() => ({
    opacity: visible.value ? 1 : 0,
  }));
  const hostStyle = layout === "fill" ? staticStyles.fillHost : staticStyles.shrinkHost;
  const contentLayout = layout === "fill" ? staticStyles.fillContent : staticStyles.shrinkContent;
  const layerStyle: StyleProp<ViewStyle> = coverNeighbor ? staticStyles.aboveNeighbor : null;
  return (
    <View pointerEvents="box-none" style={[hostStyle, layerStyle]}>
      {/* Clips the slabs to this pane. The shifted content is a sibling, so it can still paint
          over the neighbor, and the slabs cannot cover that neighbor with a flat color. */}
      <View pointerEvents="none" style={staticStyles.slabClip}>
        <Animated.View
          pointerEvents="none"
          style={[
            staticStyles.slab,
            staticStyles.leadingSlab,
            { backgroundColor: leadingFill },
            leadingStyle,
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            staticStyles.slab,
            staticStyles.trailingSlab,
            { backgroundColor: trailingFill },
            trailingStyle,
          ]}
        />
      </View>
      <Animated.View pointerEvents="box-none" style={[contentLayout, contentStyle]}>
        {children}
        <Animated.View pointerEvents="none" style={[staticStyles.edgeChrome, chromeStyle]}>
          <View style={[staticStyles.border, { backgroundColor: borderColor }]} />
          <View style={[staticStyles.grip, { backgroundColor: gripColor }]} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

/**
 * The 1px border that stays on the committed edge. It hides while the drag shows the moving border,
 * and it is a separate node from any Reanimated width so Unistyles never shares that width node.
 */
export function SidebarResizeCommittedEdge({
  preview,
  color,
  edge,
}: {
  preview: SidebarResizePreviewValues | null;
  color: string;
  edge: "left" | "right";
}) {
  const opacityStyle = useAnimatedStyle(() => {
    if (preview === null) return { opacity: 1 };
    return { opacity: preview.visible.value ? 0 : 1 };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        edge === "left" ? staticStyles.committedLeft : staticStyles.committedRight,
        { backgroundColor: color },
        opacityStyle,
      ]}
    />
  );
}

const staticStyles = RNStyleSheet.create({
  fillHost: {
    flex: 1,
    overflow: "visible",
  },
  shrinkHost: {
    alignSelf: "stretch",
    flexDirection: "row",
    flexShrink: 0,
    overflow: "visible",
  },
  fillContent: {
    flex: 1,
  },
  shrinkContent: {
    alignSelf: "stretch",
    flexDirection: "row",
  },
  aboveNeighbor: {
    zIndex: 2,
  },
  slabClip: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    overflow: "hidden",
  },
  slab: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: SIDEBAR_RESIZE_SLAB,
  },
  leadingSlab: {
    left: 0,
  },
  trailingSlab: {
    right: 0,
  },
  edgeChrome: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -6,
    width: 12,
    zIndex: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  border: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 6,
    width: 1,
  },
  grip: {
    width: 4,
    height: 40,
    borderRadius: 2,
  },
  committedLeft: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: 1,
    zIndex: 5,
  },
  committedRight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 1,
    zIndex: 5,
  },
});
