import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import type { ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGenericKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import {
  useAnimatedStyle,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
  resolveKeyboardShift,
  shouldReconcileHiddenKeyboardEnd,
} from "@/hooks/keyboard-shift-policy";
import {
  KeyboardShiftContext,
  SettledKeyboardShiftContext,
  useKeyboardShift,
} from "@/hooks/keyboard-shift-context";

type KeyboardShiftMode = "translate" | "padding";

export function KeyboardShiftProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);
  const isIos = Platform.OS === "ios";
  const isMoving = useSharedValue(false);
  const [settledShift, setSettledShift] = useState(0);
  const publishSettledShift = useCallback((nextShift: number) => {
    setSettledShift((currentShift) => (currentShift === nextShift ? currentShift : nextShift));
  }, []);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [bottomInset, insets.bottom]);

  const shift = useDerivedValue(() => {
    "worklet";
    return resolveKeyboardShift({
      rawKeyboardHeight: Math.abs(keyboardHeight.value),
      keyboardProgress: keyboardProgress.value,
      bottomInset: bottomInset.value,
      isIos,
      iosMinHeight: DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
    });
  });

  useGenericKeyboardHandler(
    {
      onStart: () => {
        "worklet";
        isMoving.value = true;
      },
      onEnd: (event) => {
        "worklet";
        if (isIos && shouldReconcileHiddenKeyboardEnd(event)) {
          keyboardHeight.value = 0;
          keyboardProgress.value = 0;
        }
        isMoving.value = false;
      },
    },
    [isIos, isMoving, keyboardHeight, keyboardProgress],
  );

  useAnimatedReaction(
    () => ({ moving: isMoving.value, shift: shift.value }),
    (current, previous) => {
      if (!current.moving && (previous === null || previous.moving)) {
        scheduleOnRN(publishSettledShift, current.shift);
      }
    },
    [isMoving, publishSettledShift, shift],
  );

  const value = useMemo(
    () => ({
      shift,
      isMoving,
      bottomInset,
    }),
    [bottomInset, isMoving, shift],
  );

  return createElement(
    KeyboardShiftContext.Provider,
    { value },
    createElement(SettledKeyboardShiftContext.Provider, { value: settledShift }, children),
  );
}

export function useKeyboardShiftStyle(input: { mode: KeyboardShiftMode; enabled?: boolean }): {
  shift: SharedValue<number>;
  style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
} {
  const { shift, bottomInset } = useKeyboardShift();
  const mode = input.mode;
  const enabled = input.enabled ?? true;

  const style = useAnimatedStyle<ViewStyle>(() => {
    "worklet";
    if (mode === "padding") {
      if (!enabled) {
        return { paddingBottom: 0 };
      }
      // Include safe-area bottom inset so content clears the home indicator even without a keyboard.
      return { paddingBottom: bottomInset.value + shift.value };
    }

    return { transform: [{ translateY: enabled ? -shift.value : 0 }] };
  }, [enabled, mode]);

  return { shift, style };
}
