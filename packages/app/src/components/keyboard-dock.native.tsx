import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useKeyboardShift } from "@/hooks/keyboard-shift-context";

interface KeyboardDockProps extends ViewProps {
  children: ReactNode;
}

export function KeyboardDock({ children, style, ...props }: KeyboardDockProps) {
  const { shift } = useKeyboardShift();
  const keyboardPaddingStyle = useAnimatedStyle(() => ({
    paddingBottom: shift.value,
  }));

  return (
    <Animated.View style={[style, keyboardPaddingStyle]} {...props}>
      {children}
    </Animated.View>
  );
}
