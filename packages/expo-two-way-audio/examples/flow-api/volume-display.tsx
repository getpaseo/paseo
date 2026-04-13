import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

export default function VolumeDisplay({
  volumeLevel,
  color,
  minSize,
  maxSize,
}: {
  volumeLevel: SharedValue<number>;
  color: string;
  minSize: number;
  maxSize: number;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const size = interpolate(volumeLevel.value, [0, 1], [minSize, maxSize]);

    return {
      width: withTiming(size, {
        duration: 100,
        easing: Easing.linear,
      }),
      height: withTiming(size, {
        duration: 100,
        easing: Easing.linear,
      }),
      borderRadius: withTiming(size / 2, {
        duration: 100,
        easing: Easing.linear,
      }),
    };
  });

  return (
    <View style={styles.container}>
      <Animated.View style={[{ backgroundColor: color }, animatedStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
    alignItems: "center",
  },
});
