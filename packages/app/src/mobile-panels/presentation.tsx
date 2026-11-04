import { useId, useMemo, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { usePanelStore, type MobilePanelView } from "@/stores/panel-store";
import { getMobilePanelFrame } from "./model";
import { useIsMobilePanelActive, useMobilePanelsRuntime } from "./provider";

type OverlayPanel = Exclude<MobilePanelView, "agent">;

interface MobilePanelOverlayProps {
  children: ReactNode;
  closeGesture: GestureType;
  panel: OverlayPanel;
  presentation?: "overlay" | "dock";
  dockVisible?: boolean;
  frameStyle?: ComponentProps<typeof Animated.View>["style"];
  panelStyle?: ComponentProps<typeof Animated.View>["style"];
}

export function MobilePanelOverlay({
  children,
  closeGesture,
  panel,
  panelStyle,
  presentation = "overlay",
  dockVisible = false,
  frameStyle,
}: MobilePanelOverlayProps) {
  const { position, windowWidth } = useMobilePanelsRuntime();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const overlayOpen = useIsMobilePanelActive(panel);
  const docked = presentation === "dock";
  const isOpen = docked ? dockVisible : overlayOpen;
  const hostId = useId();
  const isLeft = panel === "agent-list";

  const sidebarAnimatedStyle = useAnimatedStyle(() => {
    if (docked) return { transform: [{ translateX: 0 }] };
    const frame = getMobilePanelFrame(position.value, windowWidth);
    return {
      transform: [{ translateX: isLeft ? frame.leftTranslateX : frame.rightTranslateX }],
    };
  }, [docked, isLeft, windowWidth]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, windowWidth);
    return { opacity: isLeft ? frame.leftBackdropOpacity : frame.rightBackdropOpacity };
  }, [isLeft, windowWidth]);

  const overlayAnimatedStyle = useAnimatedStyle(() => {
    if (docked) return { opacity: 1, display: "flex" as const, pointerEvents: "box-none" as const };
    const isVisible = isLeft ? position.value < 0 : position.value > 0;
    if (isWeb) {
      return { display: isVisible ? ("flex" as const) : ("none" as const) };
    }
    // Preserve native scroll ranges while hidden. Collapsing layout makes Android
    // spring retained scroll offsets back to zero on touch cancellation or release.
    return {
      opacity: isVisible ? 1 : 0,
      pointerEvents: isVisible ? ("box-none" as const) : ("none" as const),
    };
  }, [docked, isLeft]);

  const positionedPanelStyle = isLeft ? styles.leftPanel : styles.rightPanel;
  const backdropStyle = useMemo(
    () => [styles.backdrop, backdropAnimatedStyle],
    [backdropAnimatedStyle],
  );
  const combinedPanelStyle = useMemo(
    () => [
      docked ? styles.dockedPanel : styles.panel,
      !docked && positionedPanelStyle,
      !docked && { width: windowWidth },
      panelStyle,
      sidebarAnimatedStyle,
    ],
    [docked, panelStyle, positionedPanelStyle, sidebarAnimatedStyle, windowWidth],
  );
  let overlayPointerEvents: "auto" | "box-none" | "none";
  if (!isWeb) {
    overlayPointerEvents = "box-none";
  } else {
    overlayPointerEvents = isOpen ? "auto" : "none";
  }

  return (
    <GestureDetector gesture={closeGesture} touchAction="pan-y">
      {/* Fabric needs an always-mounted native host to attach the close handler while the
          retained panel content is hidden. nativeID keeps that host registered. */}
      <Animated.View
        accessibilityElementsHidden={!isOpen}
        collapsable={false}
        importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
        nativeID={`${panel}-gesture-host-${hostId}`}
        pointerEvents={overlayPointerEvents}
        style={[
          docked ? styles.dock : styles.overlay,
          frameStyle,
          docked && !dockVisible && { display: "none" },
        ]}
      >
        <Animated.View style={[docked ? styles.dockedPanel : styles.overlay, overlayAnimatedStyle]}>
          <Pressable
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={showMobileAgent}
            pointerEvents={isOpen ? "auto" : "none"}
            style={[StyleSheet.absoluteFill, docked && { display: "none" }]}
            testID={isOpen ? `${panel}-backdrop` : undefined}
          >
            <Animated.View pointerEvents="none" style={backdropStyle} />
          </Pressable>

          <Animated.View pointerEvents={isOpen ? "auto" : "none"} style={combinedPanelStyle}>
            <WindowChromeRootRegion corners="both">{children}</WindowChromeRootRegion>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

// Reanimated owns only these static native styles and the derived transform.
// Theme values stay inline at call sites, avoiding Unistyles patching the same
// native node after Fabric commits.
const styles = StyleSheet.create({
  dock: { flexShrink: 0, minHeight: 0 },
  dockedPanel: { flex: 1, minHeight: 0, overflow: "hidden" },
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
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
