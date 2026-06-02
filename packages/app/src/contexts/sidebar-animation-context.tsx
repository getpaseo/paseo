import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Keyboard, useWindowDimensions } from "react-native";
import { useSharedValue, withTiming, Easing, type SharedValue } from "react-native-reanimated";
import { type GestureType } from "react-native-gesture-handler";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import {
  getLeftSidebarAnimationTargets,
  MOBILE_PANEL_STATE_AGENT,
  MOBILE_PANEL_STATE_AGENT_LIST_CLOSING,
  MOBILE_PANEL_STATE_AGENT_LIST_OPEN,
  MOBILE_PANEL_STATE_AGENT_LIST_OPENING,
  MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING,
  MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN,
  MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING,
  MOBILE_PANEL_TARGET_AGENT,
  MOBILE_PANEL_TARGET_AGENT_LIST,
  MOBILE_PANEL_TARGET_FILE_EXPLORER,
  shouldSettleMobilePanelTransition,
  shouldSyncSidebarAnimation,
} from "@/utils/sidebar-animation-state";

const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
export const MOBILE_VISUAL_PANEL_AGENT = 0;
export const MOBILE_VISUAL_PANEL_AGENT_LIST = 1;
export const MOBILE_VISUAL_PANEL_FILE_EXPLORER = 2;

interface SidebarAnimationContextValue {
  translateX: SharedValue<number>;
  backdropOpacity: SharedValue<number>;
  windowWidth: number;
  animateToOpen: () => void;
  animateToClose: () => void;
  startMobilePanelTransition: (mobileView: "agent" | "agent-list" | "file-explorer") => void;
  settleMobilePanel: (mobileView: "agent" | "agent-list" | "file-explorer") => void;
  isGesturing: SharedValue<boolean>;
  mobileVisualPanel: SharedValue<number>;
  mobilePanelState: SharedValue<number>;
  gestureAnimatingRef: React.MutableRefObject<boolean>;
  openGestureRef: React.MutableRefObject<GestureType | undefined>;
  closeGestureRef: React.MutableRefObject<GestureType | undefined>;
}

const SidebarAnimationContext = createContext<SidebarAnimationContextValue | null>(null);

function getMobileVisualPanel(mobileView: "agent" | "agent-list" | "file-explorer"): number {
  if (mobileView === "agent-list") {
    return MOBILE_VISUAL_PANEL_AGENT_LIST;
  }
  if (mobileView === "file-explorer") {
    return MOBILE_VISUAL_PANEL_FILE_EXPLORER;
  }
  return MOBILE_VISUAL_PANEL_AGENT;
}

function getSettledMobilePanelState(mobileView: "agent" | "agent-list" | "file-explorer"): number {
  if (mobileView === "agent-list") {
    return MOBILE_PANEL_STATE_AGENT_LIST_OPEN;
  }
  if (mobileView === "file-explorer") {
    return MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN;
  }
  return MOBILE_PANEL_STATE_AGENT;
}

export function SidebarAnimationProvider({ children }: { children: ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  const isCompactLayout = useIsCompactFormFactor();
  const mobileView = usePanelStore((state) => state.mobileView);
  const isOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isCompactLayout }),
  );

  // Initialize based on current state
  const initialTargets = getLeftSidebarAnimationTargets({ isOpen, windowWidth });
  const translateX = useSharedValue(initialTargets.translateX);
  const backdropOpacity = useSharedValue(initialTargets.backdropOpacity);
  const isGesturing = useSharedValue(false);
  const mobileVisualPanel = useSharedValue(getMobileVisualPanel(mobileView));
  const mobilePanelState = useSharedValue(getSettledMobilePanelState(mobileView));
  const mobilePanelTarget = useSharedValue(getMobileVisualPanel(mobileView));
  const gestureAnimatingRef = useRef(false);
  const openGestureRef = useRef<GestureType | undefined>(undefined);
  const closeGestureRef = useRef<GestureType | undefined>(undefined);

  // Track previous isOpen to detect changes
  const prevIsOpen = useRef(isOpen);
  const prevMobileView = useRef(mobileView);
  const prevWindowWidth = useRef(windowWidth);

  const startMobilePanelTransition = useCallback(
    (nextMobileView: "agent" | "agent-list" | "file-explorer") => {
      "worklet";
      if (nextMobileView === "agent-list") {
        mobilePanelTarget.value = MOBILE_PANEL_TARGET_AGENT_LIST;
        mobilePanelState.value = MOBILE_PANEL_STATE_AGENT_LIST_OPENING;
        return;
      }
      if (nextMobileView === "file-explorer") {
        mobilePanelTarget.value = MOBILE_PANEL_TARGET_FILE_EXPLORER;
        mobilePanelState.value = MOBILE_PANEL_STATE_FILE_EXPLORER_OPENING;
        return;
      }
      mobilePanelTarget.value = MOBILE_PANEL_TARGET_AGENT;
      if (mobilePanelState.value === MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN) {
        mobilePanelState.value = MOBILE_PANEL_STATE_FILE_EXPLORER_CLOSING;
        return;
      }
      if (mobilePanelState.value === MOBILE_PANEL_STATE_AGENT_LIST_OPEN) {
        mobilePanelState.value = MOBILE_PANEL_STATE_AGENT_LIST_CLOSING;
        return;
      }
      mobilePanelState.value = MOBILE_PANEL_STATE_AGENT;
    },
    [mobilePanelState, mobilePanelTarget],
  );

  const settleMobilePanel = useCallback(
    (nextMobileView: "agent" | "agent-list" | "file-explorer") => {
      "worklet";
      if (nextMobileView === "agent-list") {
        if (
          !shouldSettleMobilePanelTransition(
            mobilePanelTarget.value,
            MOBILE_PANEL_TARGET_AGENT_LIST,
          )
        ) {
          return;
        }
        mobileVisualPanel.value = MOBILE_VISUAL_PANEL_AGENT_LIST;
        mobilePanelState.value = MOBILE_PANEL_STATE_AGENT_LIST_OPEN;
        return;
      }
      if (nextMobileView === "file-explorer") {
        if (
          !shouldSettleMobilePanelTransition(
            mobilePanelTarget.value,
            MOBILE_PANEL_TARGET_FILE_EXPLORER,
          )
        ) {
          return;
        }
        mobileVisualPanel.value = MOBILE_VISUAL_PANEL_FILE_EXPLORER;
        mobilePanelState.value = MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN;
        return;
      }
      if (!shouldSettleMobilePanelTransition(mobilePanelTarget.value, MOBILE_PANEL_TARGET_AGENT)) {
        return;
      }
      mobileVisualPanel.value = MOBILE_VISUAL_PANEL_AGENT;
      mobilePanelState.value = MOBILE_PANEL_STATE_AGENT;
    },
    [mobileVisualPanel, mobilePanelState, mobilePanelTarget],
  );

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
    const previousMobileView = prevMobileView.current;
    const ownsMobileViewChange = previousMobileView === "agent-list" || mobileView === "agent-list";
    prevIsOpen.current = isOpen;
    prevMobileView.current = mobileView;
    prevWindowWidth.current = windowWidth;
    const didOpen = !previousIsOpen && isOpen;

    if (!didStateChange && !didMobileViewChange) {
      return;
    }

    if (didOpen && isCompactLayout && isNative) {
      Keyboard.dismiss();
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
      if (isOpen) {
        if (isCompactLayout) {
          startMobilePanelTransition("agent-list");
        }
        translateX.value = withTiming(
          targets.translateX,
          {
            duration: ANIMATION_DURATION,
            easing: ANIMATION_EASING,
          },
          (finished) => {
            if (!finished) return;
            if (isCompactLayout) {
              settleMobilePanel("agent-list");
            }
          },
        );
        backdropOpacity.value = withTiming(targets.backdropOpacity, {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        });
        return;
      }

      if (isCompactLayout && mobileView === "agent") {
        startMobilePanelTransition("agent");
      }
      translateX.value = withTiming(
        targets.translateX,
        {
          duration: ANIMATION_DURATION,
          easing: ANIMATION_EASING,
        },
        (finished) => {
          if (!finished) return;
          if (isCompactLayout && mobileView === "agent") {
            settleMobilePanel("agent");
          }
        },
      );
      backdropOpacity.value = withTiming(targets.backdropOpacity, {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
      return;
    }

    translateX.value = targets.translateX;
    backdropOpacity.value = targets.backdropOpacity;
    if (isCompactLayout && ownsMobileViewChange) {
      settleMobilePanel(mobileView);
    }
  }, [
    isOpen,
    mobileView,
    translateX,
    backdropOpacity,
    windowWidth,
    isGesturing,
    isCompactLayout,
    mobileVisualPanel,
    mobilePanelState,
    startMobilePanelTransition,
    settleMobilePanel,
  ]);

  const animateToOpen = useCallback(() => {
    "worklet";
    startMobilePanelTransition("agent-list");
    translateX.value = withTiming(
      0,
      {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      },
      (finished) => {
        if (!finished) return;
        settleMobilePanel("agent-list");
      },
    );
    backdropOpacity.value = withTiming(1, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [translateX, backdropOpacity, startMobilePanelTransition, settleMobilePanel]);

  const animateToClose = useCallback(() => {
    "worklet";
    startMobilePanelTransition("agent");
    translateX.value = withTiming(
      -windowWidth,
      {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      },
      (finished) => {
        if (!finished) return;
        settleMobilePanel("agent");
      },
    );
    backdropOpacity.value = withTiming(0, {
      duration: ANIMATION_DURATION,
      easing: ANIMATION_EASING,
    });
  }, [translateX, backdropOpacity, windowWidth, startMobilePanelTransition, settleMobilePanel]);

  const value = useMemo<SidebarAnimationContextValue>(
    () => ({
      translateX,
      backdropOpacity,
      windowWidth,
      animateToOpen,
      animateToClose,
      startMobilePanelTransition,
      settleMobilePanel,
      isGesturing,
      mobileVisualPanel,
      mobilePanelState,
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
      startMobilePanelTransition,
      settleMobilePanel,
      isGesturing,
      mobileVisualPanel,
      mobilePanelState,
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
