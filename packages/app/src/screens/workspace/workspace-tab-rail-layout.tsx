import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { StyleSheet } from "react-native-unistyles";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import {
  resolveWorkspaceTabRailWidth,
  shouldUseCompactWorkspaceHeader,
} from "@/screens/workspace/workspace-tab-layout";
import type { TabRailPlacement } from "@/hooks/use-settings";
import { usePanelStore } from "@/stores/panel-store";

/** The rail's slot in a pane's chrome, filled only while tabs are placed on top. */
export function WorkspaceTopTabRail({
  placement,
  children,
}: {
  placement: TabRailPlacement;
  children: ReactNode;
}) {
  return placement === "top" ? children : null;
}

interface WorkspaceTabRailLayoutProps {
  placement: TabRailPlacement;
  /**
   * Whether the pane swaps its chrome for the compact header once it gets narrow. That header
   * carries the tab switcher, so a rail on the left gives way to it.
   */
  yieldsToCompactHeader: boolean;
  /**
   * Exactly two children, in order: the tab rail, then the pane content. The rail draws only when
   * it is placed on the left, and the content holds the same place in the tree either way, so
   * moving the tabs never remounts a pane. A pane with no rail of its own passes `null`.
   */
  children: [tabRail: ReactNode, content: ReactNode];
}

/** A pane's body: its content, with the tab rail beside it when tabs are placed on the left. */
export function WorkspaceTabRailLayout({
  placement,
  yieldsToCompactHeader,
  children: [tabRail, content],
}: WorkspaceTabRailLayoutProps) {
  const { width: windowWidth } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState(windowWidth);
  const measurePane = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    // A retained pane that is hidden reports zero. Keep the width it last drew at.
    if (measured > 0) setPaneWidth(measured);
  }, []);
  const showsCompactHeader = yieldsToCompactHeader && shouldUseCompactWorkspaceHeader(paneWidth);
  const showsTabRail = placement === "left" && tabRail !== null && !showsCompactHeader;

  return (
    <View style={styles.layout} onLayout={measurePane}>
      {showsTabRail ? <ResizableTabRail paneWidth={paneWidth}>{tabRail}</ResizableTabRail> : null}
      {content}
    </View>
  );
}

function ResizableTabRail({ paneWidth, children }: { paneWidth: number; children: ReactNode }) {
  const storedWidth = usePanelStore((state) => state.tabRailWidth);
  const setStoredWidth = usePanelStore((state) => state.setTabRailWidth);
  const visibleWidth = resolveWorkspaceTabRailWidth({ requestedWidth: storedWidth, paneWidth });
  const startWidth = useSharedValue(visibleWidth);
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
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidth.value = visibleWidth - event.translationX;
          resizeWidth.value = visibleWidth;
        })
        .onUpdate((event) => {
          resizeWidth.value = resolveWorkspaceTabRailWidth({
            requestedWidth: startWidth.value + event.translationX,
            paneWidth,
          });
        })
        .onEnd((_event, success) => {
          if (success) runOnJS(setStoredWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      paneWidth,
      resizeWidth,
      setStoredWidth,
      showResizeGrip,
      startWidth,
      visibleWidth,
    ],
  );
  const widthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));

  return (
    <Animated.View style={[styles.rail, widthStyle]}>
      {children}
      <SidebarResizeHandle
        edge="right"
        gesture={resizeGesture}
        pressed={resizePressed}
        testID="workspace-tabs-column-resize-handle"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  layout: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "row",
  },
  rail: {
    position: "relative",
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
}));
