import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useWindowDimensions } from "react-native";
import {
  useSharedValue,
  withTiming,
  Easing,
  type SharedValue,
} from "react-native-reanimated";
import { type GestureType } from "react-native-gesture-handler";
import { UnistylesRuntime } from "react-native-unistyles";
import { usePanelStore } from "@/stores/panel-store";

const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);

interface SidebarAnimationContextValue {
  translateX: SharedValue<number>;
  backdropOpacity: SharedValue<number>;
  windowWidth: number;
  animateToOpen: () => void;
  animateToClose: () => void;
  isGesturing: SharedValue<boolean>;
  closeGestureRef: React.MutableRefObject<GestureType | undefined>;
}

const SidebarAnimationContext = createContext<SidebarAnimationContextValue | null>(null);

export function SidebarAnimationProvider({ children }: { children: ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);

  // Derive isOpen from the unified panel state
  const isOpen = isMobile ? mobileView === "agent-list" : desktopAgentListOpen;

  // Initialize based on current state
  const translateX = useSharedValue(isOpen ? 0 : -windowWidth);
  const backdropOpacity = useSharedValue(isOpen ? 1 : 0);
  const isGesturing = useSharedValue(false);
  const closeGestureRef = useRef<GestureType | undefined>(undefined);

  // Track previous isOpen to detect changes
  const prevIsOpen = useRef(isOpen);

  // Sync animation with store state changes (e.g., backdrop tap, programmatic open/close)
  useEffect(() => {
    // Skip if this is initial render or if we're mid-gesture
    if (prevIsOpen.current === isOpen) {
      return;
    }
    prevIsOpen.current = isOpen;

    // Don't animate if we're in the middle of a gesture - the gesture handler will handle it
    if (isGesturing.value) {
      return;
    }

    if (isOpen) {
      translateX.value = withTiming(0, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
      backdropOpacity.value = withTiming(1, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
    } else {
      translateX.value = withTiming(-windowWidth, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
      backdropOpacity.value = withTiming(0, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
    }
  }, [isOpen, translateX, backdropOpacity, windowWidth, isGesturing]);

  const animateToOpen = () => {
    "worklet";
    translateX.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(1, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  };

  const animateToClose = () => {
    "worklet";
    translateX.value = withTiming(-windowWidth, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  };

  return (
    <SidebarAnimationContext.Provider
      value={{
        translateX,
        backdropOpacity,
        windowWidth,
        animateToOpen,
        animateToClose,
        isGesturing,
        closeGestureRef,
      }}
    >
      {children}
    </SidebarAnimationContext.Provider>
  );
}

export function useSidebarAnimation() {
  const context = useContext(SidebarAnimationContext);
  if (!context) {
    throw new Error("useSidebarAnimation must be used within SidebarAnimationProvider");
  }
  return context;
}
