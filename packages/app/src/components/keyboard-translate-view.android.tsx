import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useKeyboardShift } from "@/hooks/keyboard-shift-context";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
}

export function KeyboardTranslateView({
  children,
  enabled = true,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const { shift } = useKeyboardShift();
  const keyboardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: enabled ? -shift.value : 0 }],
  }));

  return (
    <Animated.View style={[style, keyboardStyle]} {...props}>
      {children}
    </Animated.View>
  );
}
