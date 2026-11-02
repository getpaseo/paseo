import { useCallback, useEffect, useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { resolveExplorerSidebarWidth } from "@/components/explorer-sidebar-layout";
import type { ExplorerGeometryInput, ExplorerGeometry } from "./geometry-types";
export function useExplorerGeometry({
  width,
  containerWidth,
  overlay,
  resizeEnabled,
  onResize,
}: ExplorerGeometryInput): ExplorerGeometry {
  const insets = useSafeAreaInsets();
  const resizeWidth = useSharedValue(width);
  const startWidth = useSharedValue(width);
  const [resizePressed, setResizePressed] = useState(false);
  useEffect(() => {
    resizeWidth.value = width;
  }, [resizeWidth, width]);

  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(resizeEnabled)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => scheduleOnRN(showResizeGrip))
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidth.value = width + event.translationX;
          resizeWidth.value = width;
        })
        .onUpdate((event) => {
          resizeWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidth.value - event.translationX,
            containerWidth,
          });
        })
        .onEnd(() => runOnJS(onResize)(resizeWidth.value))
        .onFinalize(() => scheduleOnRN(hideResizeGrip)),
    [
      resizeEnabled,
      onResize,
      containerWidth,
      hideResizeGrip,
      resizeWidth,
      showResizeGrip,
      startWidth,
      width,
    ],
  );
  // Reanimated retains the last animated value when its style is removed. Keep this
  // style attached across folding and explicitly size overlays to the workspace viewport.
  const animatedWidthStyle = useAnimatedStyle(
    () => ({
      width: overlay ? containerWidth : resizeWidth.value,
    }),
    [containerWidth, overlay],
  );
  return {
    frameStyle: animatedWidthStyle,
    panelStyle: {
      paddingTop: insets.top + (overlay ? HEADER_TOP_PADDING_MOBILE : 0),
      paddingLeft: overlay ? insets.left : 0,
      paddingRight: overlay ? insets.right : 0,
    },
    resizeHandle: (
      <SidebarResizeHandle
        edge="left"
        gesture={resizeGesture}
        pressed={resizePressed}
        testID="native-explorer-sidebar-resize-handle"
      />
    ),
  };
}
