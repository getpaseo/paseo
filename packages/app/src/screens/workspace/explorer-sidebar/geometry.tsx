import { useCallback, useEffect, useMemo, useState } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { usePublishExplorerResizeWidth } from "@/window-layout/sidebar-resize-geometry";
import type { ExplorerGeometryInput, ExplorerGeometry } from "./geometry-types";
export function useExplorerGeometry({
  workspaceKey,
  width,
  containerWidth,
  overlay,
  resizeEnabled,
  onResize,
}: ExplorerGeometryInput): ExplorerGeometry {
  const insets = useSafeAreaInsets();
  const publishExplorerResizeWidth = usePublishExplorerResizeWidth(workspaceKey, containerWidth);
  const resizePublication = useMemo(
    () => ({
      active: false,
      enabled: resizeEnabled && !overlay,
      publish: publishExplorerResizeWidth,
    }),
    [publishExplorerResizeWidth, overlay, resizeEnabled],
  );
  const publishResizeWidth = useCallback(
    (nextWidth: number | null) => {
      if (resizePublication.active) resizePublication.publish(nextWidth);
    },
    [resizePublication],
  );
  const resizeWidth = useSharedValue(width);
  const startWidth = useSharedValue(width);
  const resize = useSharedValue<ExplorerSidebarResize | null>(null);
  const resizeWorkspaceKey = useSharedValue(workspaceKey);
  const [resizePressed, setResizePressed] = useState(false);
  useEffect(() => {
    resizePublication.active = resizePublication.enabled;
    resize.value = null;
    setResizePressed(false);
    return () => {
      // An old workspace/allocation may still have work queued on the JS thread.
      resizePublication.active = false;
      resizePublication.publish(null);
    };
  }, [resize, resizePublication]);
  useAnimatedReaction(
    () => ({
      resize: resize.value,
      ownerWorkspaceKey: resizeWorkspaceKey.value,
      workspaceKey,
      width,
      containerWidth,
      overlay,
      resizeEnabled,
    }),
    ({
      resize: currentResize,
      ownerWorkspaceKey,
      workspaceKey: currentWorkspaceKey,
      ...allocation
    }) => {
      const nextResize =
        ownerWorkspaceKey === currentWorkspaceKey
          ? reconcileExplorerSidebarResize(currentResize, allocation)
          : null;
      if (nextResize !== currentResize) {
        resize.value = nextResize;
        if (!nextResize) runOnJS(publishResizeWidth)(null);
      }
    },
    [
      containerWidth,
      overlay,
      publishResizeWidth,
      resize,
      resizeEnabled,
      resizeWorkspaceKey,
      width,
      workspaceKey,
    ],
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
          const previousResize = resizeWorkspaceKey.value === workspaceKey ? resize.value : null;
          const currentWidth = resolveExplorerSidebarFrameWidth({
            width,
            containerWidth,
            overlay,
            resizeEnabled,
            resize: previousResize,
            resizeWidth: resizeWidth.value,
          });
          resizeWorkspaceKey.value = workspaceKey;
          resize.value = beginExplorerSidebarResize(previousResize, {
            width,
            containerWidth,
            overlay,
            resizeEnabled,
          });
          startWidth.value = currentWidth + event.translationX;
          resizeWidth.value = currentWidth;
          runOnJS(publishResizeWidth)(resizeWidth.value);
        })
        .onUpdate((event) => {
          if (!resize.value || resizeWorkspaceKey.value !== workspaceKey) return;
          resizeWidth.value = resolveExplorerSidebarWidth({
            requestedWidth: startWidth.value - event.translationX,
            containerWidth,
          });
          runOnJS(publishResizeWidth)(resizeWidth.value);
        })
        .onEnd((_event, success) => {
          if (resizeWorkspaceKey.value !== workspaceKey) return;
          {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, success);
            if (!success || !resize.value) return;
          }
          runOnJS(onResize)(resizeWidth.value);
        })
        .onFinalize((_event, success) => {
          if (!success && resizeWorkspaceKey.value === workspaceKey) {
            resize.value = finishExplorerSidebarResize(resize.value, resizeWidth.value, false);
          }
          runOnJS(publishResizeWidth)(null);
          scheduleOnRN(hideResizeGrip);
        }),
    [
      resizeEnabled,
      onResize,
      containerWidth,
      hideResizeGrip,
      overlay,
      publishResizeWidth,
      resize,
      resizeWidth,
      resizeWorkspaceKey,
      showResizeGrip,
      startWidth,
      width,
      workspaceKey,
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
          resize: resizeWorkspaceKey.value === workspaceKey ? resize.value : null,
          resizeWidth: resizeWidth.value,
        }),
      };
    }
  }, [containerWidth, overlay, resizeEnabled, width, workspaceKey]);
  return {
    frameStyle: animatedWidthStyle,
    panelStyle: {
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
