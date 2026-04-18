import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useWindowDimensions } from "react-native";
import { useSharedValue, withTiming, Easing, type SharedValue } from "react-native-reanimated";
import { type GestureType } from "react-native-gesture-handler";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import {
  getLeftSidebarAnimationTargets,
  shouldSyncSidebarAnimation,
} from "@/utils/sidebar-animation-state";

const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);

interface SidebarAnimationContextValue {
  translateX: SharedValue<number>;
  backdropOpacity: SharedValue<number>;
  windowWidth: number;
  animateToOpen: () => void;
  animateToClose: () => void;
  isGesturing: SharedValue<boolean>;
  gestureAnimatingRef: React.MutableRefObject<boolean>;
  openGestureRef: React.MutableRefObject<GestureType | undefined>;
  closeGestureRef: React.MutableRefObject<GestureType | undefined>;
}

const SidebarAnimationContext = createContext<SidebarAnimationContextValue | null>(null);

export function SidebarAnimationProvider({ children }: { children: ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  const isCompactLayout = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);

  // Derive isOpen from the unified panel state
  const isOpen = isCompactLayout ? mobileView === "agent-list" : desktopAgentListOpen;

  // Initialize based on current state
  const initialTargets = getLeftSidebarAnimationTargets({ isOpen, windowWidth });
  const translateX = useSharedValue(initialTargets.translateX);
  const backdropOpacity = useSharedValue(initialTargets.backdropOpacity);
  const isGesturing = useSharedValue(false);
  const gestureAnimatingRef = useRef(false);
  const openGestureRef = useRef<GestureType | undefined>(undefined);
  const closeGestureRef = useRef<GestureType | undefined>(undefined);

  // Track previous isOpen to detect changes
  const prevIsOpen = useRef(isOpen);
  const prevWindowWidth = useRef(windowWidth);

  // Sync animation with store state changes (e.g., backdrop tap, programmatic open/close)
  useEffect(() => {
    const didStateChange = shouldSyncSidebarAnimation({
      previousIsOpen: prevIsOpen.current,
      nextIsOpen: isOpen,
      previousWindowWidth: prevWindowWidth.current,
      nextWindowWidth: windowWidth,
    });
    const previousIsOpen = prevIsOpen.current;
    prevIsOpen.current = isOpen;
    prevWindowWidth.current = windowWidth;

    if (!didStateChange) {
      return;
    }

    // Gesture onEnd already started the animation on the UI thread — skip to avoid
    // a second competing withTiming that can desync translateX and backdropOpacity
    // after a provider remount (e.g. theme change).
    if (gestureAnimatingRef.current) {
      gestureAnimatingRef.current = false;
      return;
    }

    // Don't animate if we're in the middle of a gesture - the gesture handler will handle it
    if (isGesturing.value) {
      return;
    }

    const targets = getLeftSidebarAnimationTargets({ isOpen, windowWidth });

    if (previousIsOpen !== isOpen) {
      translateX.value = withTiming(targets.translateX, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
      backdropOpacity.value = withTiming(targets.backdropOpacity, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
      return;
    }

    translateX.value = targets.translateX;
    backdropOpacity.value = targets.backdropOpacity;
  }, [isOpen, translateX, backdropOpacity, windowWidth, isGesturing]);

  const animateToOpen = useCallback(() => {
    "worklet";
    translateX.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(1, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [translateX, backdropOpacity]);

  const animateToClose = useCallback(() => {
    "worklet";
    translateX.value = withTiming(-windowWidth, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [translateX, backdropOpacity, windowWidth]);

  const value = useMemo<SidebarAnimationContextValue>(
    () => ({
      translateX,
      backdropOpacity,
      windowWidth,
      animateToOpen,
      animateToClose,
      isGesturing,
      gestureAnimatingRef,
      openGestureRef,
      closeGestureRef,
    }),
    [
      translateX,
      backdropOpacity,
      windowWidth,
      animateToOpen,
      animateToClose,
      isGesturing,
      gestureAnimatingRef,
      openGestureRef,
      closeGestureRef,
    ],
  );

  return (
    <SidebarAnimationContext.Provider value={value}>{children}</SidebarAnimationContext.Provider>
  );
}

export function useSidebarAnimation() {
  const context = useContext(SidebarAnimationContext);
  if (!context) {
    throw new Error("useSidebarAnimation must be used within SidebarAnimationProvider");
  }
  return context;
}
