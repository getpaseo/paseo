import type { ReactNode } from "react";
import { Children, useCallback, useEffect, useMemo, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  beginSidebarResize,
  endSidebarResize,
  resolveSidebarResizePreviewOffset,
} from "@/components/sidebar-resize-activity";
import {
  hideSidebarResizeShift,
  SidebarResizeCommittedEdge,
  SidebarResizeShift,
  useSidebarResizePreviewValues,
} from "@/components/sidebar-resize-preview";
import { isNative } from "@/constants/platform";
import {
  acceptTreeRailContainerMeasurement,
  resolveVisibleTreeRailWidth,
} from "@/components/tree-rail-layout";
import { usePanelStore } from "@/stores/panel-store";

export interface TreeRailProps {
  /**
   * Exactly two children, in order: content, then tree.
   *
   * Slots are children rather than `content` / `tree` props because `react-perf/jsx-no-jsx-as-prop`
   * rejects JSX in a prop, including via a local variable. Pass both unconditionally — a `{cond &&
   * …}` slot collapses out of the array and silently promotes the tree into the content position.
   * Branch around the whole rail instead, the way `diff-panel.tsx` does.
   */
  children: ReactNode;
  testID?: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  minimumWidth?: number;
  borderColor?: string;
  leadingFill?: string;
  trailingFill?: string;
  gripColor?: string;
}

/** Content-left/tree-right master-detail geometry with one app-wide tree width. */
function TreeRailBase({
  children,
  testID,
  width,
  onWidthChange,
  minimumWidth,
  borderColor,
  leadingFill,
  trailingFill,
  gripColor,
}: TreeRailProps) {
  const [content, tree] = Children.toArray(children);
  const sharedWidth = usePanelStore((state) => state.treeRailWidth);
  const setSharedWidth = usePanelStore((state) => state.setTreeRailWidth);
  const requestedWidth = width ?? sharedWidth;
  const { width: viewportWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(viewportWidth);
  const visibleWidth = resolveVisibleTreeRailWidth(requestedWidth, containerWidth, minimumWidth);
  // A shared value: a ref written in `onStart` is a copy that `onUpdate` never sees.
  const startWidth = useSharedValue(visibleWidth);
  const resizeWidth = useSharedValue(visibleWidth);
  const targetWidth = useSharedValue(visibleWidth);
  const resizePressed = useSharedValue(false);
  const preview = useSidebarResizePreviewValues();
  // On native the drag holds the committed width and shifts the rail, so the content beside it
  // lays out once, when the drag ends. Web follows the drag live.
  const heldPreview = isNative ? preview : null;

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          resizePressed.value = true;
        })
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          runOnJS(beginSidebarResize)();
          startWidth.value = visibleWidth + event.translationX;
          resizeWidth.value = visibleWidth;
          targetWidth.value = visibleWidth;
          if (heldPreview) {
            heldPreview.offset.value = 0;
            heldPreview.visible.value = true;
          }
        })
        .onUpdate((event) => {
          targetWidth.value = resolveVisibleTreeRailWidth(
            startWidth.value - event.translationX,
            containerWidth,
            minimumWidth,
          );
          if (heldPreview) {
            heldPreview.offset.value = resolveSidebarResizePreviewOffset({
              grows: "left",
              committedWidth: visibleWidth,
              targetWidth: targetWidth.value,
            });
          } else {
            resizeWidth.value = targetWidth.value;
          }
        })
        .onEnd((_event, success) => {
          // The width lands in the frame that returns the shift to 0, before React acknowledges it.
          if (success) resizeWidth.value = targetWidth.value;
          if (heldPreview) hideSidebarResizeShift(heldPreview);
          if (success) runOnJS(onWidthChange ?? setSharedWidth)(targetWidth.value);
          runOnJS(endSidebarResize)();
        })
        .onFinalize((_event, success) => {
          if (!success) resizeWidth.value = visibleWidth;
          if (heldPreview) hideSidebarResizeShift(heldPreview);
          resizePressed.value = false;
        }),
    [
      containerWidth,
      heldPreview,
      onWidthChange,
      minimumWidth,
      resizePressed,
      resizeWidth,
      setSharedWidth,
      startWidth,
      targetWidth,
      visibleWidth,
    ],
  );
  const railWidthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) =>
      setContainerWidth((currentWidth) =>
        acceptTreeRailContainerMeasurement(currentWidth, event.nativeEvent.layout.width),
      ),
    [],
  );

  const handle = (
    <SidebarResizeHandle
      edge="left"
      gesture={resizeGesture}
      pressed={resizePressed}
      held={heldPreview?.visible}
      testID={testID ? `${testID}-resize-handle` : "tree-rail-resize-handle"}
    />
  );
  const canShift = heldPreview !== null && leadingFill && trailingFill && borderColor && gripColor;
  return (
    <View style={styles.container} testID={testID} onLayout={handleLayout}>
      <View style={styles.content} testID={testID ? `${testID}-content` : undefined}>
        {content}
      </View>
      <Animated.View
        style={[styles.rail, railWidthStyle]}
        testID={testID ? `${testID}-tree` : undefined}
      >
        {borderColor ? (
          <SidebarResizeCommittedEdge preview={heldPreview} color={borderColor} edge="left" />
        ) : null}
        {canShift ? (
          <SidebarResizeShift
            preview={heldPreview}
            leadingFill={leadingFill}
            trailingFill={trailingFill}
            borderColor={borderColor}
            gripColor={gripColor}
            layout="fill"
          >
            {handle}
            {tree}
          </SidebarResizeShift>
        ) : (
          <>
            {handle}
            {tree}
          </>
        )}
      </Animated.View>
    </View>
  );
}

export const TreeRail = withUnistyles(TreeRailBase, (theme) => ({
  borderColor: theme.colors.border,
  leadingFill: theme.colors.background,
  trailingFill: theme.colors.surfaceSidebar,
  gripColor: theme.colors.accent,
}));

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  // The width node below is already shared by Unistyles and Reanimated. Its border lives on a
  // separate node so the drag does not add another animated style to that pair.
  rail: {
    position: "relative",
    flexShrink: 0,
  },
});
