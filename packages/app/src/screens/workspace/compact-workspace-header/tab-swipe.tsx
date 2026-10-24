import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector, PointerType } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  useMobilePanelOpenGestureExclusion,
  useMobilePanelsRuntime,
} from "@/mobile-panels/provider";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

interface WorkspaceTabSwipeAreaProps {
  active: boolean;
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  onSelectTab: (key: string) => void;
  children: ReactNode;
}

export function WorkspaceTabSwipeArea({
  active,
  tabs,
  activeTabKey,
  onSelectTab,
  children,
}: WorkspaceTabSwipeAreaProps) {
  const { leftOpenGestureRef, rightOpenGestureRef } = useMobilePanelsRuntime();
  const exclusion = useMobilePanelOpenGestureExclusion(active);
  const startedTabKey = useSharedValue("");
  const singleTouch = useSharedValue(false);
  const selection = useRef({ tabs, activeTabKey, onSelectTab });
  useLayoutEffect(() => {
    selection.current = { tabs, activeTabKey, onSelectTab };
  }, [tabs, activeTabKey, onSelectTab]);

  const selectAdjacentTab = useCallback((key: string, direction: number) => {
    const current = selection.current;
    // A selection made while the finger was down supersedes this gesture.
    if (key !== current.activeTabKey) return;
    const index = current.tabs.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const adjacent = current.tabs[index + direction];
    if (adjacent) current.onSelectTab(adjacent.key);
  }, []);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(active)
        .activeOffsetX([-20, 20])
        .failOffsetY([-12, 12])
        .maxPointers(1)
        // Header swipes own tab navigation; the surrounding panel gestures wait.
        .blocksExternalGesture(leftOpenGestureRef, rightOpenGestureRef)
        .onBegin(() => {
          startedTabKey.value = activeTabKey;
        })
        .onTouchesDown((event, manager) => {
          singleTouch.value =
            event.numberOfTouches === 1 && event.pointerType === PointerType.TOUCH;
          if (!singleTouch.value) manager.fail();
        })
        .onEnd((event, success) => {
          // Keep short flicks from changing tabs, even when their velocity is high.
          if (
            success &&
            singleTouch.value &&
            event.pointerType === PointerType.TOUCH &&
            Math.abs(event.translationX) >= 48 &&
            Math.abs(event.translationX) > Math.abs(event.translationY) * 2
          ) {
            scheduleOnRN(selectAdjacentTab, startedTabKey.value, event.translationX < 0 ? 1 : -1);
          }
        }),
    [
      activeTabKey,
      active,
      leftOpenGestureRef,
      rightOpenGestureRef,
      selectAdjacentTab,
      singleTouch,
      startedTabKey,
    ],
  );

  return (
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        ref={exclusion.ref}
        onLayout={exclusion.onLayout}
        collapsable={false}
        testID="workspace-tab-swipe-area"
      >
        {children}
      </View>
    </GestureDetector>
  );
}
