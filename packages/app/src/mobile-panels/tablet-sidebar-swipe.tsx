import { useCallback, useMemo, type ReactNode } from "react";
import {
  Dimensions,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { isTabletLayoutWindow } from "@/constants/tablet-layout";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { usePanelStore } from "@/stores/panel-store";
import { useMobilePanelsRuntime } from "./provider";
import {
  resolveTabletSidebarSwipe,
  resolveTabletSidebarSwipeAction,
  type TabletSidebarSwipe,
} from "./tablet-sidebar-swipe-intent";

import { AssistantSelectionCopySurface } from "@/assistant-selection-copy/surface";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  showExplorerSidebar,
  hideExplorerSidebar,
  isExplorerSidebarOpen,
  useIsExplorerSidebarOpen,
} from "@/workspace-tabs/explorer-sidebar";

function useTabletExplorerQuery() {
  const selection = useActiveWorkspaceSelection();
  const workspaceKey = selection ? `${selection.serverId}:${selection.workspaceId}` : null;
  return useMemo(() => ({ isCompact: false, workspaceKey }), [workspaceKey]);
}

interface Props {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Only the transcript owns this gesture: tabs, composer and previews keep their own drags. */
export function TabletSidebarSwipeSurface(props: Props) {
  const enabled = useTabletSidebarGesturesEnabled();
  const explorer = useTabletExplorerQuery();
  const onSwipe = useCallback(
    (side: TabletSidebarSwipe) => {
      const panel = usePanelStore.getState();
      const action = resolveTabletSidebarSwipeAction(side, {
        leftOpen: panel.desktop.agentListOpen,
        rightOpen: isExplorerSidebarOpen(explorer),
      });
      if (action === "close-left") panel.closeDesktopAgentList();
      else if (action === "close-right") hideExplorerSidebar(explorer);
      else if (action === "open-left") panel.openDesktopAgentList();
      else showExplorerSidebar(explorer);
    },
    [explorer],
  );
  const content = (
    <AssistantSelectionCopySurface style={props.style}>
      {props.children}
    </AssistantSelectionCopySurface>
  );
  if (Platform.OS !== "android") return content;
  return (
    <TabletSidebarSwipeHandler enabled={enabled} onSwipe={onSwipe}>
      {content}
    </TabletSidebarSwipeHandler>
  );
}

function useTabletSidebarGesturesEnabled() {
  const compact = useIsCompactFormFactor();
  const { width, height } = useWindowDimensions();
  const screen = Dimensions.get("screen");
  return (
    Platform.OS === "android" &&
    !compact &&
    isTabletLayoutWindow({ width, height, screenWidth: screen.width, screenHeight: screen.height })
  );
}

/** Sidebars accept only their own closing direction, including over their scrollable content. */
export function TabletSidebarCloseSurface({
  children,
  side,
}: {
  children: ReactNode;
  side: TabletSidebarSwipe;
}) {
  const enabled = useTabletSidebarGesturesEnabled();
  const explorer = useTabletExplorerQuery();
  const onSwipe = useCallback(
    (swipe: TabletSidebarSwipe) => {
      if (swipe === side) return;
      const panel = usePanelStore.getState();
      if (side === "left") panel.closeDesktopAgentList();
      else hideExplorerSidebar(explorer);
    },
    [side, explorer],
  );
  if (Platform.OS !== "android") return children;
  return (
    <TabletSidebarSwipeHandler enabled={enabled} onSwipe={onSwipe} closeSide={side}>
      {children}
    </TabletSidebarSwipeHandler>
  );
}

function TabletSidebarSwipeHandler({
  children,
  onSwipe,
  closeSide,
  enabled,
}: {
  children: ReactNode;
  onSwipe: (side: TabletSidebarSwipe) => void;
  closeSide?: TabletSidebarSwipe;
  enabled: boolean;
}) {
  const { width } = useWindowDimensions();
  const { openGesturesBlocked } = useMobilePanelsRuntime();
  const horizontalScroll = useHorizontalScrollOptional();
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startedAt = useSharedValue(0);
  const activated = useSharedValue(false);
  const leftOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const explorer = useTabletExplorerQuery();
  const rightOpen = useIsExplorerSidebarOpen(explorer);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .maxPointers(1)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          activated.value = false;
          if (!touch) return;
          startX.value = touch.absoluteX;
          startY.value = touch.absoluteY;
          startedAt.value = Date.now();
        })
        .onTouchesMove((event, manager) => {
          const touch = event.changedTouches[0];
          if (
            !touch ||
            event.numberOfTouches !== 1 ||
            horizontalScroll?.activeGestureStartedScrolled.value
          ) {
            manager.fail();
            return;
          }
          if (activated.value) return;
          const deltaX = touch.absoluteX - startX.value;
          const dx = Math.abs(deltaX);
          const closing = deltaX < 0 ? leftOpen : rightOpen;
          const wrongCloseDirection = closeSide === (deltaX > 0 ? "left" : "right");
          if (dx >= 20 && (wrongCloseDirection || (openGesturesBlocked.value && !closing))) {
            manager.fail();
            return;
          }
          const dy = Math.abs(touch.absoluteY - startY.value);
          // Release vertical scrolling and long-press text selection before claiming a pan.
          if ((dy > 10 && dy >= dx) || Date.now() - startedAt.value > 300) manager.fail();
          else if (dx >= 20 && dx > dy * 1.5) manager.activate();
        })
        .onStart(() => {
          activated.value = true;
        })
        .onEnd((event, success) => {
          if (!success) return;
          const side = resolveTabletSidebarSwipe({
            translationX: event.translationX,
            translationY: event.translationY,
            velocityX: event.velocityX,
            width,
          });
          if (!side) return;
          const closing = side === "right" ? leftOpen : rightOpen;
          if (openGesturesBlocked.value && !closing) return;
          scheduleOnRN(onSwipe, side);
        }),
    [
      activated,
      enabled,
      horizontalScroll?.activeGestureStartedScrolled,
      openGesturesBlocked,
      onSwipe,
      closeSide,
      leftOpen,
      rightOpen,
      startX,
      startY,
      startedAt,
      width,
    ],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false} style={styles.fill} testID="tablet-chat-sidebar-swipe">
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
