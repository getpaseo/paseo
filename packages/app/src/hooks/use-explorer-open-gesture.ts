import { useCallback, useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import { Extrapolation, interpolate, runOnJS, useSharedValue } from "react-native-reanimated";
import { useExplorerSidebarAnimation } from "@/contexts/explorer-sidebar-animation-context";
import { useSidebarAnimation } from "@/contexts/sidebar-animation-context";

interface UseExplorerOpenGestureParams {
  enabled: boolean;
  onOpen: () => void;
}

export function useExplorerOpenGesture({ enabled, onOpen }: UseExplorerOpenGestureParams) {
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    gestureAnimatingRef,
    openGestureRef,
  } = useExplorerSidebarAnimation();
  const { openGestureRef: leftOpenGestureRef } = useSidebarAnimation();
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  const handleGestureOpen = useCallback(() => {
    gestureAnimatingRef.current = true;
    onOpen();
  }, [onOpen, gestureAnimatingRef]);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(openGestureRef)
        .simultaneousWithExternalGesture(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }

          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);

          // Fail quickly on rightward or clearly vertical intent.
          if (deltaX >= 10) {
            stateManager.fail();
            return;
          }
          if (absDeltaY > 10 && absDeltaY > absDeltaX) {
            stateManager.fail();
            return;
          }

          // Activate only on intentional leftward movement.
          if (deltaX <= -15 && absDeltaX > absDeltaY) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          // Right sidebar: start from closed position (+windowWidth) and move towards 0.
          const newTranslateX = Math.max(
            0,
            Math.min(windowWidth, windowWidth + event.translationX),
          );
          translateX.value = newTranslateX;
          backdropOpacity.value = interpolate(
            newTranslateX,
            [windowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP,
          );
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldOpenByPosition = translateX.value < (windowWidth * 2) / 3;
          const shouldOpenByVelocity = event.velocityX < -500;
          const shouldOpen = shouldOpenByPosition || shouldOpenByVelocity;
          if (shouldOpen) {
            animateToOpen();
            runOnJS(handleGestureOpen)();
          } else {
            animateToClose();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      enabled,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToOpen,
      animateToClose,
      isGesturing,
      openGestureRef,
      leftOpenGestureRef,
      handleGestureOpen,
      touchStartX,
      touchStartY,
    ],
  );
}
