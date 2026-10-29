import { useMemo, useRef, type ReactNode } from "react";
import type { View, ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { KeyboardTranslationContext, useKeyboardShift } from "./context";
import { useKeyboardTranslationScope } from "./measure";
import { resolveKeyboardLift } from "./policy";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  /** Space below the view's resting position that the keyboard may fill before the view moves. */
  bottomClearance?: number;
}

export function KeyboardTranslateView({
  children,
  enabled = true,
  bottomClearance = 0,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const { shift } = useKeyboardShift();
  const frameRef = useRef<View>(null);
  const translation = useMemo(() => ({ enabled, bottomClearance }), [bottomClearance, enabled]);
  const scope = useKeyboardTranslationScope(frameRef, translation);
  const keyboardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -resolveKeyboardLift({ shift: shift.value, ...translation }) }],
  }));

  return (
    <Animated.View ref={frameRef} style={[style, keyboardStyle]} {...props}>
      <KeyboardTranslationContext.Provider value={scope}>
        {children}
      </KeyboardTranslationContext.Provider>
    </Animated.View>
  );
}
