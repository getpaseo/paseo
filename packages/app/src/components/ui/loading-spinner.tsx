import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { Loader2 } from "lucide-react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

type SpinnerSizePreset = "small" | "large";

interface LoadingSpinnerProps {
  color: string;
  size?: SpinnerSizePreset | number;
}

const SIZE_PRESETS = {
  small: 14,
  large: 18,
} as const;

const STROKE_WIDTH = 1.5;
const SPIN_DURATION_MS = 750;

function resolvePixelSize(size: SpinnerSizePreset | number): number {
  if (typeof size === "number") {
    return size;
  }
  return SIZE_PRESETS[size];
}

export function LoadingSpinner({ color, size = "small" }: LoadingSpinnerProps) {
  const pixelSize = resolvePixelSize(size);
  const reduceMotion = useReducedMotion();
  const rotation = useSharedValue(0);
  const boxStyle = useMemo(() => ({ width: pixelSize, height: pixelSize }) as const, [pixelSize]);

  useEffect(() => {
    if (reduceMotion) {
      rotation.value = 0;
      return;
    }
    rotation.value = 0;
    rotation.value = withRepeat(
      withTiming(360, { duration: SPIN_DURATION_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(rotation);
    };
  }, [reduceMotion, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <View accessibilityRole="progressbar" style={boxStyle} testID="loading-spinner">
      <Animated.View style={[boxStyle, animatedStyle]}>
        <Loader2 size={pixelSize} color={color} strokeWidth={STROKE_WIDTH} />
      </Animated.View>
    </View>
  );
}
