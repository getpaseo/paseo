import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Keyboard, useWindowDimensions } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import {
  cancelAnimation,
  Easing,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN, scheduleOnUI } from "react-native-worklets";
import { isNative } from "@/constants/platform";
import {
  usePanelStore,
  type MobilePanelSelection,
  type MobilePanelView,
} from "@/stores/panel-store";
import {
  canBeginMobilePanelGesture,
  createMobilePanelMotionState,
  getMobilePanelAnchor,
  isMobilePanelGestureCurrent,
  transitionMobilePanel,
  type MobilePanelCommit,
  type MobilePanelMotionState,
  type MobilePanelTransition,
} from "./model";

const ANIMATION_DURATION = 220;
const ANIMATION_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);
const LEFT_PANEL_MASK = 1;
const RIGHT_PANEL_MASK = 2;

function getPanelMask(panel: MobilePanelView): number {
  if (panel === "agent-list") {
    return LEFT_PANEL_MASK;
  }
  if (panel === "file-explorer") {
    return RIGHT_PANEL_MASK;
  }
  return 0;
}

interface MobilePanelsRuntime {
  beginGesture: (input: BeginGestureInput) => number;
  finishGesture: (input: FinishGestureInput) => MobilePanelCommit | null;
  leftCloseGestureRef: RefObject<GestureType | undefined>;
  leftOpenGestureRef: RefObject<GestureType | undefined>;
  motionState: SharedValue<MobilePanelMotionState>;
  position: SharedValue<number>;
  rightCloseGestureRef: RefObject<GestureType | undefined>;
  rightOpenGestureRef: RefObject<GestureType | undefined>;
  updateGesture: (startedRevision: number, nextPosition: number) => boolean;
  windowWidth: number;
}

interface BeginGestureInput {
  origin: MobilePanelView;
  preview: MobilePanelView;
}

interface FinishGestureInput {
  startedRevision: number;
  success: boolean;
  target: MobilePanelView;
}

const MobilePanelsContext = createContext<MobilePanelsRuntime | null>(null);
const MobilePanelPresentationContext = createContext(0);

export function MobilePanelsProvider({ children }: { children: ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  const initialSelection = useRef(usePanelStore.getState().mobilePanel).current;
  const position = useSharedValue(getMobilePanelAnchor(initialSelection.target));
  const motionState = useSharedValue(createMobilePanelMotionState(initialSelection));
  const leftOpenGestureRef = useRef<GestureType | undefined>(undefined);
  const leftCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const rightOpenGestureRef = useRef<GestureType | undefined>(undefined);
  const rightCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const [presentedPanels, setPresentedPanels] = useState(getPanelMask(initialSelection.target));

  const presentPanel = useCallback((panel: MobilePanelView) => {
    const mask = getPanelMask(panel);
    if (mask) {
      setPresentedPanels((current) => current | mask);
    }
  }, []);

  const settlePresentation = useCallback((panel: MobilePanelView, revision: number) => {
    const selection = usePanelStore.getState().mobilePanel;
    if (selection.revision !== revision || selection.target !== panel) {
      return;
    }
    setPresentedPanels(getPanelMask(panel));
  }, []);

  const animateTransition = useCallback(
    (transition: MobilePanelTransition) => {
      "worklet";
      if (!transition.animationTarget) {
        return;
      }
      const target = transition.animationTarget;
      const revision = transition.state.revision;
      position.value = withTiming(
        getMobilePanelAnchor(target),
        { duration: ANIMATION_DURATION, easing: ANIMATION_EASING },
        (finished) => {
          if (!finished) {
            return;
          }
          const currentState = motionState.value;
          const settled = transitionMobilePanel(currentState, {
            type: "animation.finished",
            revision,
            target,
          });
          if (settled.state === currentState) {
            return;
          }
          motionState.value = settled.state;
          scheduleOnRN(settlePresentation, target, revision);
        },
      );
    },
    [motionState, position, settlePresentation],
  );

  const applySelection = useCallback(
    (selection: MobilePanelSelection) => {
      "worklet";
      const currentState = motionState.value;
      const transition = transitionMobilePanel(currentState, {
        type: "command",
        selection,
      });
      if (transition.state === currentState) {
        return;
      }
      motionState.value = transition.state;
      animateTransition(transition);
    },
    [animateTransition, motionState],
  );

  useEffect(() => {
    return usePanelStore.subscribe((state, previousState) => {
      const selection = state.mobilePanel;
      if (selection === previousState.mobilePanel) {
        return;
      }
      if (selection.target !== "agent") {
        presentPanel(selection.target);
        if (isNative) {
          Keyboard.dismiss();
        }
      }
      scheduleOnUI(applySelection, selection);
    });
  }, [applySelection, presentPanel]);

  const beginGesture = useCallback(
    ({ origin, preview }: BeginGestureInput): number => {
      "worklet";
      const currentState = motionState.value;
      if (!canBeginMobilePanelGesture(currentState, origin, position.value)) {
        return -1;
      }
      const transition = transitionMobilePanel(currentState, {
        type: "gesture.begin",
        origin,
      });
      motionState.value = transition.state;
      cancelAnimation(position);
      scheduleOnRN(presentPanel, preview);
      return transition.state.gesture?.startedRevision ?? -1;
    },
    [motionState, position, presentPanel],
  );

  const updateGesture = useCallback(
    (startedRevision: number, nextPosition: number): boolean => {
      "worklet";
      if (!isMobilePanelGestureCurrent(motionState.value, startedRevision)) {
        return false;
      }
      position.value = Math.max(-1, Math.min(1, nextPosition));
      return true;
    },
    [motionState, position],
  );

  const finishGesture = useCallback(
    ({ startedRevision, target, success }: FinishGestureInput): MobilePanelCommit | null => {
      "worklet";
      const currentState = motionState.value;
      const transition = transitionMobilePanel(currentState, {
        type: "gesture.finish",
        startedRevision,
        success,
        target,
      });
      if (transition.state === currentState) {
        return null;
      }
      motionState.value = transition.state;
      animateTransition(transition);
      return transition.commit ?? null;
    },
    [animateTransition, motionState],
  );

  const value = useMemo<MobilePanelsRuntime>(
    () => ({
      beginGesture,
      finishGesture,
      leftCloseGestureRef,
      leftOpenGestureRef,
      motionState,
      position,
      rightCloseGestureRef,
      rightOpenGestureRef,
      updateGesture,
      windowWidth,
    }),
    [beginGesture, finishGesture, motionState, position, updateGesture, windowWidth],
  );

  return (
    <MobilePanelsContext.Provider value={value}>
      <MobilePanelPresentationContext.Provider value={presentedPanels}>
        {children}
      </MobilePanelPresentationContext.Provider>
    </MobilePanelsContext.Provider>
  );
}

/** Internal to the mobile-panels module. Callers use gesture and presentation adapters. */
export function useMobilePanelsRuntime(): MobilePanelsRuntime {
  const context = useContext(MobilePanelsContext);
  if (!context) {
    throw new Error("useMobilePanelsRuntime must be used within MobilePanelsProvider");
  }
  return context;
}

export function useIsMobilePanelPresented(panel: MobilePanelView): boolean {
  const presentedPanels = useContext(MobilePanelPresentationContext);
  return (presentedPanels & getPanelMask(panel)) !== 0;
}
