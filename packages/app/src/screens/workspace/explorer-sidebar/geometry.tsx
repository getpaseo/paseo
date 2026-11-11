import { useCallback, useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import {
  beginExplorerSidebarResize,
  finishExplorerSidebarResize,
  reconcileExplorerSidebarResize,
  resolveExplorerSidebarFrameWidth,
  resolveExplorerSidebarWidth,
  type ExplorerSidebarResize,
} from "@/components/explorer-sidebar-layout";
import { useWorkspaceWidth } from "@/window-layout/workspace-width";
import type { ExplorerGeometryInput, ExplorerGeometry } from "./geometry-types";
export function useExplorerGeometry({
  width,
  requestedWidth,
  overlay,
  isOpen,
  resizeEnabled,
  onResize,
}: ExplorerGeometryInput): ExplorerGeometry {
  const insets = useSafeAreaInsets();
  const resizeWidth = useSharedValue(width);
  const startWidth = useSharedValue(width);
  const resize = useSharedValue<ExplorerSidebarResize | null>(null);
  const [resizePressed, setResizePressed] = useState(false);
  const { contentWidth } = useWorkspaceWidth();
  const allocation = useDerivedValue(() => {
    const containerWidth = contentWidth.value;
    return {
      width: resolveExplorerSidebarWidth({ requestedWidth, containerWidth }),
      containerWidth,
      overlay,
      resizeEnabled,
    };
  }, [contentWidth, requestedWidth, overlay, resizeEnabled]);
  useAnimatedReaction(
    () => ({ resize: resize.value, allocation: allocation.value }),
    ({ resize: currentResize, allocation: currentAllocation }) => {
      const nextResize = reconcileExplorerSidebarResize(currentResize, currentAllocation);
      if (nextResize !== currentResize) resize.value = nextResize;
    },
    [allocation, resize],
  );

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
          const currentWidth = resolveExplorerSidebarFrameWidth({
            ...allocation.value,
            resize: resize.value,
            resizeWidth: resizeWidth.value,
          });
          resize.value = beginExplorerSidebarResize(resize.value, allocation.value);
          startWidth.value = currentWidth + event.translationX;
          resizeWidth.value = currentWidth;
        })
        .onUpdate((event) => {
          if (!resize.value) return;
          resizeWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidth.value - event.translationX,
            containerWidth: allocation.value.containerWidth,
          });
        })
        .onEnd((_event, success) => {
          {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, success);
            if (!success || !resize.value) return;
          }
          runOnJS(onResize)(resizeWidth.value);
        })
        .onFinalize((_event, success) => {
          if (!success) {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, false);
          }
          scheduleOnRN(hideResizeGrip);
        }),
    [
      resizeEnabled,
      allocation,
      onResize,
      hideResizeGrip,
      resize,
      resizeWidth,
      showResizeGrip,
      startWidth,
    ],
  );
  // Fabric must receive visibility and width together. Revealing from React first can expose
  // the hidden dock's previous width. Hidden overlays retain their native scroll ranges.
  const animatedWidthStyle = useAnimatedStyle(
    () => ({
      display: overlay || isOpen ? "flex" : "none",
      width: resolveExplorerSidebarFrameWidth({
        ...allocation.value,
        resize: resize.value,
        resizeWidth: resizeWidth.value,
      }),
    }),
    [allocation, overlay, isOpen],
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
