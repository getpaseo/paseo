import { useMemo, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { usePanelStore, type MobilePanelView } from "@/stores/panel-store";
import { getMobilePanelFrame } from "./model";
import { useIsMobilePanelPresented, useMobilePanelsRuntime } from "./provider";

type OverlayPanel = Exclude<MobilePanelView, "agent">;

interface MobilePanelOverlayProps {
  children: ReactNode;
  closeGesture: GestureType;
  panel: OverlayPanel;
  panelStyle?: ComponentProps<typeof Animated.View>["style"];
}

export function MobilePanelOverlay({
  children,
  closeGesture,
  panel,
  panelStyle,
}: MobilePanelOverlayProps) {
  const { position, windowWidth } = useMobilePanelsRuntime();
  const target = usePanelStore((state) => state.mobilePanel.target);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const isOpen = target === panel;
  const isPresented = useIsMobilePanelPresented(panel);
  const isLeft = panel === "agent-list";

  const sidebarAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, windowWidth);
    return {
      transform: [{ translateX: isLeft ? frame.leftTranslateX : frame.rightTranslateX }],
    };
  }, [isLeft, windowWidth]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, windowWidth);
    return { opacity: isLeft ? frame.leftBackdropOpacity : frame.rightBackdropOpacity };
  }, [isLeft, windowWidth]);

  const overlayStyle = useMemo(
    () => [styles.overlay, { display: isPresented ? ("flex" as const) : ("none" as const) }],
    [isPresented],
  );
  const positionedPanelStyle = isLeft ? styles.leftPanel : styles.rightPanel;
  const backdropStyle = useMemo(
    () => [styles.backdrop, backdropAnimatedStyle],
    [backdropAnimatedStyle],
  );
  const combinedPanelStyle = useMemo(
    () => [
      styles.panel,
      positionedPanelStyle,
      { width: windowWidth },
      panelStyle,
      sidebarAnimatedStyle,
    ],
    [panelStyle, positionedPanelStyle, sidebarAnimatedStyle, windowWidth],
  );
  let overlayPointerEvents: "auto" | "box-none" | "none";
  if (!isWeb) {
    overlayPointerEvents = "box-none";
  } else {
    overlayPointerEvents = isOpen ? "auto" : "none";
  }

  return (
    <View style={overlayStyle} pointerEvents={overlayPointerEvents}>
      <Pressable
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={showMobileAgent}
        pointerEvents={isOpen ? "auto" : "none"}
        style={StyleSheet.absoluteFillObject}
        testID={`${panel}-backdrop`}
      >
        <Animated.View pointerEvents="none" style={backdropStyle} />
      </Pressable>

      <GestureDetector gesture={closeGesture} touchAction="pan-y">
        <Animated.View pointerEvents={isOpen ? "auto" : "none"} style={combinedPanelStyle}>
          <WindowChromeRootRegion corners="both">{children}</WindowChromeRootRegion>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// Reanimated owns only these static native styles and the derived transform.
// Theme values stay inline at call sites, avoiding Unistyles patching the same
// native node after Fabric commits.
const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    overflow: "hidden",
  },
  leftPanel: {
    left: 0,
  },
  rightPanel: {
    right: 0,
  },
});
