import { useEffect } from "react";
import { View } from "react-native";
import ReanimatedAnimated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

interface VolumeMeterProps {
  volume: number;
}

export function VolumeMeter({ volume }: VolumeMeterProps) {
  const { theme } = useUnistyles();

  // Base dimensions
  const LINE_SPACING = 8;
  const MAX_HEIGHT = 80;
  const MIN_HEIGHT = 4;

  // Shared values for each line's height
  const line1Height = useSharedValue(MIN_HEIGHT);
  const line2Height = useSharedValue(MIN_HEIGHT);
  const line3Height = useSharedValue(MIN_HEIGHT);

  // Idle pulse animations (when no volume)
  const line1Pulse = useSharedValue(1);
  const line2Pulse = useSharedValue(1);
  const line3Pulse = useSharedValue(1);

  // Start idle animations with different phases
  useEffect(() => {
    // Line 1 - fastest pulse
    line1Pulse.value = withRepeat(
      withSequence(
        withTiming(1.2, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );

    // Line 2 - medium pulse with offset
    line2Pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 400 }),
        withTiming(1.15, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );

    // Line 3 - slowest pulse with different offset
    line3Pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 600 }),
        withTiming(1.25, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []);

  // Update heights based on volume with different responsiveness per line
  useEffect(() => {
    if (volume > 0.01) {
      // Active volume - animate heights based on volume
      // Line 1 - most responsive, follows volume closely
      const target1 = MIN_HEIGHT + (MAX_HEIGHT * volume * 1.2);
      line1Height.value = withSpring(target1, {
        damping: 10,
        stiffness: 200,
      });

      // Line 2 - medium responsiveness
      const target2 = MIN_HEIGHT + (MAX_HEIGHT * volume * 0.9);
      line2Height.value = withSpring(target2, {
        damping: 12,
        stiffness: 150,
      });

      // Line 3 - smoothest, lags behind
      const target3 = MIN_HEIGHT + (MAX_HEIGHT * volume * 0.7);
      line3Height.value = withSpring(target3, {
        damping: 15,
        stiffness: 100,
      });
    } else {
      // No volume - return to minimum
      line1Height.value = withSpring(MIN_HEIGHT, {
        damping: 20,
        stiffness: 150,
      });
      line2Height.value = withSpring(MIN_HEIGHT, {
        damping: 20,
        stiffness: 150,
      });
      line3Height.value = withSpring(MIN_HEIGHT, {
        damping: 20,
        stiffness: 150,
      });
    }
  }, [volume]);

  // Animated styles for each line
  const line1Style = useAnimatedStyle(() => ({
    height: line1Height.value * (volume > 0.01 ? 1 : line1Pulse.value),
    opacity: 0.8 + (volume * 0.2),
  }));

  const line2Style = useAnimatedStyle(() => ({
    height: line2Height.value * (volume > 0.01 ? 1 : line2Pulse.value),
    opacity: 0.7 + (volume * 0.3),
  }));

  const line3Style = useAnimatedStyle(() => ({
    height: line3Height.value * (volume > 0.01 ? 1 : line3Pulse.value),
    opacity: 0.6 + (volume * 0.4),
  }));

  return (
    <View style={styles.container}>
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: 4,
            backgroundColor: theme.colors.palette.blue[400],
          },
          line1Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: 6,
            backgroundColor: theme.colors.palette.blue[500],
          },
          line2Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: 4,
            backgroundColor: theme.colors.palette.blue[400],
          },
          line3Style,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 100,
  },
  line: {
    borderRadius: theme.borderRadius.full,
  },
}));
