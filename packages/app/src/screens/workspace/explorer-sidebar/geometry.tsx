import { useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HEADER_TOP_PADDING_MOBILE } from "@/constants/layout";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  beginSidebarResize,
  endSidebarResize,
  resolveSidebarResizePreviewOffset,
} from "@/components/sidebar-resize-activity";
import {
  hideSidebarResizeShift,
  useSidebarResizePreviewValues,
} from "@/components/sidebar-resize-preview";
import { isNative } from "@/constants/platform";
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
  const resize = useSharedValue<ExplorerSidebarResize | null>(null);
  // A shared value so pressing and releasing the grip does not re-render the workspace.
  const resizePressed = useSharedValue(false);
  // The width the finger asks for. Under a held drag it reaches the frame only when the drag ends.
  const targetWidth = useSharedValue(width);
  const preview = useSidebarResizePreviewValues();
  // On native the drag holds the committed width and shifts the dock, so the workspace column
  // beside it lays out once, when the drag ends. Web follows the drag live.
  const heldPreview = isNative ? preview : null;
  useAnimatedReaction(
    () => ({ resize: resize.value, width, containerWidth, overlay, resizeEnabled }),
    ({ resize: currentResize, ...allocation }) => {
      const nextResize = reconcileExplorerSidebarResize(currentResize, allocation);
      if (nextResize !== currentResize) resize.value = nextResize;
    },
    [containerWidth, overlay, resize, resizeEnabled, width],
  );

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(resizeEnabled)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          resizePressed.value = true;
        })
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          runOnJS(beginSidebarResize)();
          const currentWidth = resolveExplorerSidebarFrameWidth({
            width,
            containerWidth,
            overlay,
            resizeEnabled,
            resize: resize.value,
            resizeWidth: resizeWidth.value,
          });
          resize.value = beginExplorerSidebarResize(resize.value, {
            width,
            containerWidth,
            overlay,
            resizeEnabled,
          });
          startWidth.value = currentWidth + event.translationX;
          resizeWidth.value = currentWidth;
          targetWidth.value = currentWidth;
          if (heldPreview) {
            heldPreview.offset.value = 0;
            heldPreview.visible.value = true;
          }
        })
        .onUpdate((event) => {
          if (!resize.value) return;
          targetWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidth.value - event.translationX,
            containerWidth,
          });
          if (heldPreview) {
            heldPreview.offset.value = resolveSidebarResizePreviewOffset({
              grows: "left",
              committedWidth: resizeWidth.value,
              targetWidth: targetWidth.value,
            });
          } else resizeWidth.value = targetWidth.value;
        })
        .onEnd((_event, success) => {
          // The width lands in the frame that returns the shift to 0; the pending resize keeps it
          // there until React acknowledges it.
          if (success) resizeWidth.value = targetWidth.value;
          if (heldPreview) hideSidebarResizeShift(heldPreview);
          runOnJS(endSidebarResize)();
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
          if (heldPreview) hideSidebarResizeShift(heldPreview);
          resizePressed.value = false;
        }),
    [
      heldPreview,
      resizeEnabled,
      onResize,
      containerWidth,
      overlay,
      resize,
      resizePressed,
      resizeWidth,
      startWidth,
      targetWidth,
      width,
    ],
  );
  // Reanimated retains the last animated value when its style is removed. Keep this
  // style attached across folding and explicitly size overlays to the workspace viewport.
  const animatedWidthStyle = useAnimatedStyle(() => {
    if (overlay) return { width: containerWidth };
    {
      return {
        width: resolveExplorerSidebarFrameWidth({
          width,
          containerWidth,
          overlay,
          resizeEnabled,
          resize: resize.value,
          resizeWidth: resizeWidth.value,
        }),
      };
    }
  }, [containerWidth, overlay, resizeEnabled, width]);
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
        held={heldPreview?.visible}
        testID="native-explorer-sidebar-resize-handle"
      />
    ),
    resizeShift: heldPreview,
  };
}
