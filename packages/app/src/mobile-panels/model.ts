import type { MobilePanelSelection, MobilePanelView } from "@/stores/panel-store";

interface MobilePanelGesture {
  startedRevision: number;
}

export interface MobilePanelMotionState extends MobilePanelSelection {
  gesture: MobilePanelGesture | null;
  motionTarget: MobilePanelView;
  settledTarget: MobilePanelView;
}

export interface MobilePanelCommit {
  startedRevision: number;
  target: MobilePanelView;
}

export interface MobilePanelTransition {
  animationTarget?: MobilePanelView;
  commit?: MobilePanelCommit;
  state: MobilePanelMotionState;
}

export type MobilePanelEvent =
  | { type: "command"; selection: MobilePanelSelection }
  | { type: "gesture.begin"; origin: MobilePanelView }
  | {
      type: "gesture.finish";
      startedRevision: number;
      success: boolean;
      target: MobilePanelView;
    }
  | { type: "animation.finished"; revision: number; target: MobilePanelView };

export function createMobilePanelMotionState(
  selection: MobilePanelSelection,
): MobilePanelMotionState {
  return {
    ...selection,
    gesture: null,
    motionTarget: selection.target,
    settledTarget: selection.target,
  };
}

export function transitionMobilePanel(
  state: MobilePanelMotionState,
  event: MobilePanelEvent,
): MobilePanelTransition {
  "worklet";
  if (event.type === "command") {
    if (event.selection.revision <= state.revision) {
      return { state };
    }
    return {
      animationTarget: event.selection.target,
      state: {
        ...state,
        ...event.selection,
        gesture: null,
        motionTarget: event.selection.target,
      },
    };
  }

  if (event.type === "gesture.begin") {
    if (
      state.gesture ||
      state.target !== event.origin ||
      state.motionTarget !== event.origin ||
      state.settledTarget !== event.origin
    ) {
      return { state };
    }
    return {
      state: {
        ...state,
        gesture: {
          startedRevision: state.revision,
        },
      },
    };
  }

  if (event.type === "gesture.finish") {
    const ownsCurrentRevision = state.gesture?.startedRevision === state.revision;
    const ownsFinish = state.gesture?.startedRevision === event.startedRevision;
    if (!ownsCurrentRevision || !ownsFinish || !state.gesture) {
      return { state };
    }
    const startedRevision = state.gesture.startedRevision;
    const target = event.success ? event.target : state.target;
    return {
      animationTarget: target,
      commit: event.success && target !== state.target ? { startedRevision, target } : undefined,
      state: {
        ...state,
        gesture: null,
        motionTarget: target,
      },
    };
  }

  const ownsCurrentRevision = event.revision === state.revision;
  const isCanonicalTarget = event.target === state.target;
  const isCurrentMotionTarget = event.target === state.motionTarget;
  if (!ownsCurrentRevision || !isCanonicalTarget || !isCurrentMotionTarget) {
    return { state };
  }
  return {
    state: { ...state, settledTarget: event.target },
  };
}

export function getMobilePanelAnchor(panel: MobilePanelView): number {
  "worklet";
  if (panel === "agent-list") {
    return -1;
  }
  if (panel === "file-explorer") {
    return 1;
  }
  return 0;
}

export function canBeginMobilePanelGesture(
  state: MobilePanelMotionState,
  origin: MobilePanelView,
  position: number,
): boolean {
  "worklet";
  const isCanonical = state.target === origin;
  const isMotionSettled = state.motionTarget === origin && state.settledTarget === origin;
  const isAtOrigin = Math.abs(position - getMobilePanelAnchor(origin)) <= 0.002;
  return !state.gesture && isCanonical && isMotionSettled && isAtOrigin;
}

export function isMobilePanelGestureCurrent(
  state: MobilePanelMotionState,
  startedRevision: number,
): boolean {
  "worklet";
  return state.revision === startedRevision && state.gesture?.startedRevision === startedRevision;
}

export function getMobilePanelFrame(position: number, width: number) {
  "worklet";
  const clampedPosition = Math.max(-1, Math.min(1, position));
  return {
    leftBackdropOpacity: Math.max(0, -clampedPosition),
    leftTranslateX: -Math.min(1, clampedPosition + 1) * width,
    rightBackdropOpacity: Math.max(0, clampedPosition),
    rightTranslateX: Math.min(1, 1 - clampedPosition) * width,
  };
}
