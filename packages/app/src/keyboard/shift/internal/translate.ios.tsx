import { useMemo, type ReactNode } from "react";
import { Animated, type ViewProps } from "react-native";
import { useKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
  const insets = useSafeAreaInsets();
  const { height, progress } = useKeyboardAnimation();
  const translateY = useMemo(
    () => Animated.add(height, Animated.multiply(progress, insets.bottom)),
    [height, insets.bottom, progress],
  );
  const keyboardStyle = useMemo(
    () => ({ transform: [{ translateY: enabled ? translateY : 0 }] }),
    [enabled, translateY],
  );

  return (
    <Animated.View style={[style, keyboardStyle]} {...props}>
      {children}
    </Animated.View>
  );
}
