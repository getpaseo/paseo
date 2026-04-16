import { useEffect } from "react";
import { RefreshCw } from "lucide-react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

interface SpinningRefreshIconProps {
  spinning: boolean;
  size: number;
  color: string;
}

export function SpinningRefreshIcon({ spinning, size, color }: SpinningRefreshIconProps) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (spinning) {
      rotation.value = 0;
      rotation.value = withRepeat(
        withTiming(360, {
          duration: 1000,
          easing: Easing.linear,
        }),
        -1,
        false,
      );
      return;
    }

    cancelAnimation(rotation);
    const remainder = rotation.value % 360;
    if (Math.abs(remainder) < 0.001) {
      rotation.value = 0;
      return;
    }

    rotation.value = withTiming(360, {
      duration: Math.max(80, Math.round(((360 - remainder) / 360) * 1000)),
      easing: Easing.linear,
    });
  }, [rotation, spinning]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        },
        animatedStyle,
      ]}
    >
      <RefreshCw size={size} color={color} />
    </Animated.View>
  );
}
