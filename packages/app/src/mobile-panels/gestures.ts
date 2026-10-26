import { createContext, useContext, useRef, type RefObject, useCallback, useMemo } from "react";
import { Gesture, PointerType, type GestureType } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { isWeb } from "@/constants/platform";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { useHasTouchScreen } from "@/hooks/use-has-touch-screen";
import { usePanelStore } from "@/stores/panel-store";
import { canBeginMobilePanelGesture, isMobilePanelGestureCurrent } from "./model";
import { useMobilePanelsRuntime } from "./provider";
import { resolveMobilePanelGestureIntent } from "./gesture-intent";

const PANEL_OPEN_EDGE_WIDTH = 32;

function isCurrentSelection(startedRevision: number): boolean {
  return usePanelStore.getState().mobilePanel.revision === startedRevision;
}

function useGestureState() {
  return {
    startedRevision: useSharedValue(-1),
    touchStartX: useSharedValue(0),
    touchStartY: useSharedValue(0),
  };
}

function useRevisionCommit(action: () => void) {
  return useCallback(
    (revision: number) => {
      if (isCurrentSelection(revision)) {
        action();
      }
    },
    [action],
  );
}

export function useOpenAgentListGesture({
  enabled,
  panelWidth,
}: {
  enabled: boolean;
  panelWidth?: number;
}) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const width = panelWidth ?? windowWidth;
  const hasTouchScreen = useHasTouchScreen();
  const horizontalScroll = useHorizontalScrollOptional();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);
  const commit = useRevisionCommit(showMobileAgentList);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftOpenGestureRef)
        .enabled(enabled && hasTouchScreen)
        .manualActivation(true)
        .onTouchesDown((event, stateManager) => {
          if (event.pointerType !== PointerType.TOUCH) {
            stateManager.fail();
            return;
          }
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            horizontalScroll?.isAnyScrolledRight.value ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({ origin: "agent" });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / width);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX > width / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "agent-list" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      commit,
      enabled,
      beginGesture,
      finishGesture,
      hasTouchScreen,
      horizontalScroll?.isAnyScrolledRight,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      width,
    ],
  );
}

export function useCloseAgentListGesture({
  enabled = true,
  panelWidth,
}: { enabled?: boolean; panelWidth?: number } = {}) {
  const {
    beginGesture,
    finishGesture,
    leftCloseGestureRef,
    motionState,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const width = panelWidth ?? windowWidth;
  const hasTouchScreen = useHasTouchScreen();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftCloseGestureRef)
        .enabled(enabled && hasTouchScreen)
        .manualActivation(true)
        .onTouchesDown((event, stateManager) => {
          if (event.pointerType !== PointerType.TOUCH) {
            stateManager.fail();
            return;
          }
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent-list", position.value) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent-list",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -1 - event.translationX / width);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX < -width / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "agent-list",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      enabled,
      hasTouchScreen,
      finishGesture,
      leftCloseGestureRef,
      motionState,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      width,
    ],
  );

  return { gesture, gestureRef: leftCloseGestureRef };
}

interface OpenFileExplorerGestureOptions {
  enabled: boolean;
  onOpen: () => void;
}

export function useOpenFileExplorerGesture({ enabled, onOpen }: OpenFileExplorerGestureOptions) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    rightOpenGestureRef,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const commit = useRevisionCommit(onOpen);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightOpenGestureRef)
        .simultaneousWithExternalGesture(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            (isWeb && touchStartX.value < windowWidth - PANEL_OPEN_EDGE_WIDTH) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "file-explorer" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      enabled,
      finishGesture,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      rightOpenGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );
}

export const FileExplorerCloseGestureContext = createContext<RefObject<
  GestureType | undefined
> | null>(null);

export function useCloseFileExplorerGesture(enabled = true) {
  const rightCloseGestureRef = useRef<GestureType | undefined>(undefined);
  const { beginGesture, finishGesture, motionState, position, updateGesture, windowWidth } =
    useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const horizontalScroll = useHorizontalScrollOptional();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightCloseGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "file-explorer", position.value) ||
            horizontalScroll?.activeGestureStartedScrolled.value ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "file-explorer",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, 1 - event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX > windowWidth / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "file-explorer",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      enabled,
      beginGesture,
      commit,
      finishGesture,
      horizontalScroll?.activeGestureStartedScrolled,
      motionState,
      position,
      rightCloseGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );

  return { gesture, gestureRef: rightCloseGestureRef };
}

export function useFileExplorerCloseGestureRef() {
  return useContext(FileExplorerCloseGestureContext);
}
