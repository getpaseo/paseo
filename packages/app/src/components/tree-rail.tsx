import type { ReactNode } from "react";
import { Children, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
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
}

/** Content-left/tree-right master-detail geometry with one app-wide tree width. */
export function TreeRail({ children, testID }: TreeRailProps) {
  const [content, tree] = Children.toArray(children);
  const requestedWidth = usePanelStore((state) => state.treeRailWidth);
  const setTreeRailWidth = usePanelStore((state) => state.setTreeRailWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(viewportWidth);
  const visibleWidth = resolveVisibleTreeRailWidth(requestedWidth, containerWidth);
  const startWidthRef = useRef(visibleWidth);
  const resizeWidth = useSharedValue(visibleWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => scheduleOnRN(showResizeGrip))
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleWidth + event.translationX;
          resizeWidth.value = visibleWidth;
        })
        .onUpdate((event) => {
          resizeWidth.value = resolveVisibleTreeRailWidth(
            startWidthRef.current - event.translationX,
            containerWidth,
          );
        })
        .onEnd(() => runOnJS(setTreeRailWidth)(resizeWidth.value))
        .onFinalize(() => scheduleOnRN(hideResizeGrip)),
    [containerWidth, hideResizeGrip, resizeWidth, setTreeRailWidth, showResizeGrip, visibleWidth],
  );
  const railWidthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) =>
      setContainerWidth((currentWidth) =>
        acceptTreeRailContainerMeasurement(currentWidth, event.nativeEvent.layout.width),
      ),
    [],
  );

  return (
    <View style={styles.container} testID={testID} onLayout={handleLayout}>
      <View style={styles.content} testID={testID ? `${testID}-content` : undefined}>
        {content}
      </View>
      <Animated.View
        style={[styles.rail, railWidthStyle]}
        testID={testID ? `${testID}-tree` : undefined}
      >
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID={testID ? `${testID}-resize-handle` : "tree-rail-resize-handle"}
        />
        {tree}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  rail: {
    position: "relative",
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
}));
