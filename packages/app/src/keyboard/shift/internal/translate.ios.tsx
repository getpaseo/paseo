import { useMemo, useEffect, useRef, type ReactNode } from "react";
import { Animated, useAnimatedValue, type View, type ViewProps } from "react-native";
import { useKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardTranslationContext } from "./context";
import { useKeyboardTranslationScope } from "./measure";

interface KeyboardTranslateViewProps extends ViewProps {
  children: ReactNode;
  enabled?: boolean;
  /** Space below the view's resting position that the keyboard may fill before the view moves. */
  bottomClearance?: number;
  /**
   * Distance the view rises beyond the keyboard's overlap of the safe area, so content
   * resting on the safe-area boundary keeps this gap above the open keyboard.
   */
  keyboardGap?: number;
}

export function KeyboardTranslateView({
  children,
  enabled = true,
  bottomClearance = 0,
  keyboardGap = 0,
  style,
  ...props
}: KeyboardTranslateViewProps) {
  const insets = useSafeAreaInsets();
  const { height, progress } = useKeyboardAnimation();
  // Mirrors resolveKeyboardLift on the native driver: `overlap` is the negated shift.
  const translateY = useMemo(() => {
    const overlap = Animated.add(height, Animated.multiply(progress, insets.bottom));
    const lift = Animated.add(overlap, bottomClearance).interpolate({
      inputRange: [-1, 0],
      outputRange: [-1, 0],
      extrapolateLeft: "extend",
      extrapolateRight: "clamp",
    });
    if (!(keyboardGap > 0)) return lift;
    const gap = overlap.interpolate({
      inputRange: [-keyboardGap, 0],
      outputRange: [-keyboardGap, 0],
      extrapolate: "clamp",
    });
    return Animated.add(lift, gap);
  }, [bottomClearance, height, insets.bottom, keyboardGap, progress]);
  // Fullscreen resizes this view while disabling translation. iOS Fabric can
  // reapply its previous transform during that layout commit. Keep the graph
  // attached and apply the mode on the native animation frame; a static zero or
  // setValue during the React commit gets overwritten by the resize. A rebuilt
  // graph (a new bottomClearance after rotation) starts from JS-side keyboard
  // values, so run it on the native frame too or it stays stale until the
  // keyboard next moves.
  const enabledValue = useAnimatedValue(enabled ? 1 : 0);
  useEffect(() => {
    const animation = Animated.timing(enabledValue, {
      toValue: enabled ? 1 : 0,
      duration: 0,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [enabled, enabledValue, translateY]);
  const keyboardStyle = useMemo(
    () => ({ transform: [{ translateY: Animated.multiply(translateY, enabledValue) }] }),
    [enabledValue, translateY],
  );

  const frameRef = useRef<View>(null);
  const translation = useMemo(
    () => ({ enabled, bottomClearance, keyboardGap }),
    [bottomClearance, enabled, keyboardGap],
  );
  const scope = useKeyboardTranslationScope(frameRef, translation);

  return (
    <Animated.View ref={frameRef} style={[style, keyboardStyle]} {...props}>
      <KeyboardTranslationContext.Provider value={scope}>
        {children}
      </KeyboardTranslationContext.Provider>
    </Animated.View>
  );
}
