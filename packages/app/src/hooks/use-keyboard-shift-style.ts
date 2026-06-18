import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import type { ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import {
  DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
  resolveKeyboardShift,
} from "@/hooks/keyboard-shift-policy";

type KeyboardShiftMode = "translate" | "padding";

interface KeyboardShiftContextValue {
  shift: SharedValue<number>;
  bottomInset: SharedValue<number>;
}

const KeyboardShiftContext = createContext<KeyboardShiftContextValue | null>(null);

export function KeyboardShiftProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);
  const isIos = Platform.OS === "ios";

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

  const value = useMemo(
    () => ({
      shift,
      bottomInset,
    }),
    [bottomInset, shift],
  );

  return createElement(KeyboardShiftContext.Provider, { value }, children);
}

export function useKeyboardShift(): KeyboardShiftContextValue {
  const context = useContext(KeyboardShiftContext);
  if (!context) {
    throw new Error("useKeyboardShift must be used inside KeyboardShiftProvider");
  }
  return context;
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
