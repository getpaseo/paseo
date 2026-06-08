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
import {
  MOBILE_VISUAL_PANEL_AGENT,
  MOBILE_VISUAL_PANEL_AGENT_LIST,
  MOBILE_VISUAL_PANEL_FILE_EXPLORER,
  useSidebarAnimation,
} from "@/contexts/sidebar-animation-context";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import {
  getRightSidebarAnimationTargets,
  shouldSyncSidebarAnimation,
} from "@/utils/sidebar-animation-state";

const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
interface ExplorerSidebarAnimationContextValue {
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

const ExplorerSidebarAnimationContext = createContext<ExplorerSidebarAnimationContextValue | null>(
  null,
);

function getMobileVisualPanel(mobileView: "agent" | "agent-list" | "file-explorer"): number {
  if (mobileView === "agent-list") {
    return MOBILE_VISUAL_PANEL_AGENT_LIST;
  }
  if (mobileView === "file-explorer") {
    return MOBILE_VISUAL_PANEL_FILE_EXPLORER;
  }
  return MOBILE_VISUAL_PANEL_AGENT;
}

export function ExplorerSidebarAnimationProvider({ children }: { children: ReactNode }) {
  const { mobileVisualPanel } = useSidebarAnimation();
  const { width: windowWidth } = useWindowDimensions();
  const isCompactLayout = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const isOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: isCompactLayout }),
  );

  // Right sidebar: closed = +windowWidth (off-screen right), open = 0
  const initialTargets = getRightSidebarAnimationTargets({ isOpen, windowWidth });
  const translateX = useSharedValue(initialTargets.translateX);
  const backdropOpacity = useSharedValue(initialTargets.backdropOpacity);
  const isGesturing = useSharedValue(false);
  const gestureAnimatingRef = useRef(false);
  const openGestureRef = useRef<GestureType | undefined>(undefined);
  const closeGestureRef = useRef<GestureType | undefined>(undefined);

  // Track previous isOpen to detect changes
  const prevIsOpen = useRef(isOpen);
  const prevMobileView = useRef(mobileView);
  const prevWindowWidth = useRef(windowWidth);

  // Sync animation with store state changes (e.g., backdrop tap, programmatic open/close)
  useEffect(() => {
    const didStateChange = shouldSyncSidebarAnimation({
      previousIsOpen: prevIsOpen.current,
      nextIsOpen: isOpen,
      previousWindowWidth: prevWindowWidth.current,
      nextWindowWidth: windowWidth,
    });
    const didMobileViewChange = prevMobileView.current !== mobileView;
    const previousIsOpen = prevIsOpen.current;
    prevIsOpen.current = isOpen;
    prevMobileView.current = mobileView;
    prevWindowWidth.current = windowWidth;

    if (!didStateChange && !didMobileViewChange) {
      return;
    }

    if (gestureAnimatingRef.current) {
      gestureAnimatingRef.current = false;
      return;
    }

    // Don't animate if we're in the middle of a gesture - the gesture handler will handle it
    if (isGesturing.value) {
      return;
    }

    if (isCompactLayout) {
      mobileVisualPanel.value = getMobileVisualPanel(mobileView);
    }

    const targets = getRightSidebarAnimationTargets({ isOpen, windowWidth });

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
  }, [
    isOpen,
    mobileView,
    translateX,
    backdropOpacity,
    windowWidth,
    isGesturing,
    isCompactLayout,
    mobileVisualPanel,
  ]);

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
    translateX.value = withTiming(windowWidth, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
    backdropOpacity.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [translateX, backdropOpacity, windowWidth]);

  const value = useMemo<ExplorerSidebarAnimationContextValue>(
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
    [translateX, backdropOpacity, windowWidth, animateToOpen, animateToClose, isGesturing],
  );

  return (
    <ExplorerSidebarAnimationContext.Provider value={value}>
      {children}
    </ExplorerSidebarAnimationContext.Provider>
  );
}

export function useExplorerSidebarAnimation() {
  const context = useContext(ExplorerSidebarAnimationContext);
  if (!context) {
    throw new Error(
      "useExplorerSidebarAnimation must be used within ExplorerSidebarAnimationProvider",
    );
  }
  return context;
}

export function useExplorerSidebarAnimationOptional() {
  return useContext(ExplorerSidebarAnimationContext);
}
