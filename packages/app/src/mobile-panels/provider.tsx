import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
  useAnimatedReaction,
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

interface MobilePanelsRuntime {
  beginGesture: (input: BeginGestureInput) => number;
  finishGesture: (input: FinishGestureInput) => MobilePanelCommit | null;
  leftCloseGestureRef: RefObject<GestureType | undefined>;
  leftOpenGestureRef: RefObject<GestureType | undefined>;
  motionState: SharedValue<MobilePanelMotionState>;
  openGesturesBlocked: SharedValue<boolean>;
  position: SharedValue<number>;
  rightCloseGestureRef: RefObject<GestureType | undefined>;
  rightOpenGestureRef: RefObject<GestureType | undefined>;
  updateGesture: (startedRevision: number, nextPosition: number) => boolean;
  setOpenGestureBlocked: (owner: symbol, blocked: boolean) => void;
  windowWidth: number;
}

interface BeginGestureInput {
  origin: MobilePanelView;
}

interface FinishGestureInput {
  startedRevision: number;
  success: boolean;
  target: MobilePanelView;
}

const MobilePanelsContext = createContext<MobilePanelsRuntime | null>(null);
const MobilePanelActiveContext = createContext<MobilePanelView>("agent");

export function MobilePanelsProvider({ children }: { children: ReactNode }) {
  const { width: windowWidth } = useWindowDimensions();
  const initialSelection = useRef(usePanelStore.getState().mobilePanel).current;
  const position = useSharedValue(getMobilePanelAnchor(initialSelection.target));
  const motionState = useSharedValue(createMobilePanelMotionState(initialSelection));
  const openGesturesBlocked = useSharedValue(false);
  const openGestureBlockersRef = useRef(new Set<symbol>());
  const leftOpenGestureRef = useRef<GestureType | undefined>(undefined);
  const leftCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const rightOpenGestureRef = useRef<GestureType | undefined>(undefined);
  const rightCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const [activePanel, setActivePanel] = useState(initialSelection.target);

  const setOpenGestureBlocked = useCallback(
    (owner: symbol, blocked: boolean) => {
      if (blocked) {
        openGestureBlockersRef.current.add(owner);
      } else {
        openGestureBlockersRef.current.delete(owner);
      }
      openGesturesBlocked.value = openGestureBlockersRef.current.size > 0;
    },
    [openGesturesBlocked],
  );

  const publishActivePanel = useCallback((panel: MobilePanelView, revision: number) => {
    const selection = usePanelStore.getState().mobilePanel;
    if (selection.revision !== revision || selection.target !== panel) {
      return;
    }
    if (isNative && panel !== "agent") {
      Keyboard.dismiss();
    }
    setActivePanel(panel);
  }, []);

  useAnimatedReaction(
    () => ({ motionState: motionState.value, position: position.value }),
    ({ motionState: currentState, position: currentPosition }) => {
      const settled = transitionMobilePanel(currentState, {
        type: "position.changed",
        position: currentPosition,
      });
      if (settled.state === currentState) {
        return;
      }
      motionState.value = settled.state;
      scheduleOnRN(publishActivePanel, settled.state.settledTarget, settled.state.revision);
    },
    [motionState, position, publishActivePanel],
  );

  const animateTransition = useCallback(
    (transition: MobilePanelTransition) => {
      "worklet";
      if (!transition.animationTarget) {
        return;
      }
      const target = transition.animationTarget;
      position.value = withTiming(getMobilePanelAnchor(target), {
        duration: ANIMATION_DURATION,
        easing: ANIMATION_EASING,
      });
    },
    [position],
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
      scheduleOnUI(applySelection, selection);
    });
  }, [applySelection]);

  const beginGesture = useCallback(
    ({ origin }: BeginGestureInput): number => {
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
      return transition.state.gesture?.startedRevision ?? -1;
    },
    [motionState, position],
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
      openGesturesBlocked,
      position,
      rightCloseGestureRef,
      rightOpenGestureRef,
      updateGesture,
      setOpenGestureBlocked,
      windowWidth,
    }),
    [
      beginGesture,
      finishGesture,
      motionState,
      openGesturesBlocked,
      position,
      setOpenGestureBlocked,
      updateGesture,
      windowWidth,
    ],
  );

  return (
    <MobilePanelsContext.Provider value={value}>
      <MobilePanelActiveContext.Provider value={activePanel}>
        {children}
      </MobilePanelActiveContext.Provider>
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

export function useIsMobilePanelActive(panel: MobilePanelView): boolean {
  return useContext(MobilePanelActiveContext) === panel;
}

export function useBlockMobilePanelOpenGestures(blocked: boolean): void {
  const { setOpenGestureBlocked } = useMobilePanelsRuntime();
  const owner = useRef(Symbol("mobile-panel-open-gesture-blocker")).current;

  useLayoutEffect(() => {
    setOpenGestureBlocked(owner, blocked);
    return () => setOpenGestureBlocked(owner, false);
  }, [blocked, owner, setOpenGestureBlocked]);
}
