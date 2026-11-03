import { useEffect, useMemo, useRef } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";

/** One looping value per skeleton, shared by its shapes so they pulse together. */
export function useSkeletonPulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);
  return pulse;
}

/** A placeholder shape; `style` sets its size, radius and color. */
export function SkeletonPulse({
  pulse,
  style,
}: {
  pulse: Animated.Value;
  style: StyleProp<ViewStyle>;
}) {
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.8],
  });
  const pulseStyle = useMemo(() => [style, { opacity }], [style, opacity]);
  return <Animated.View style={pulseStyle} />;
}
