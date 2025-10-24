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
  isMuted?: boolean;
  isDetecting?: boolean;
  isSpeaking?: boolean;
  orientation?: "vertical" | "horizontal";
}

export function VolumeMeter({ volume, isMuted = false, isDetecting = false, isSpeaking = false, orientation = "vertical" }: VolumeMeterProps) {
  const { theme } = useUnistyles();

  // Base dimensions
  const LINE_SPACING = 8;
  const MAX_HEIGHT = orientation === "horizontal" ? 30 : 50;
  const MIN_HEIGHT = orientation === "horizontal" ? 12 : 20;

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
    if (isMuted) {
      // When muted, set pulse to 1 (no animation)
      line1Pulse.value = 1;
      line2Pulse.value = 1;
      line3Pulse.value = 1;
      return;
    }

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
  }, [isMuted]);

  // Update heights based on volume with different responsiveness per line
  useEffect(() => {
    if (isMuted) {
      // When muted, keep lines at minimum height without animation
      line1Height.value = MIN_HEIGHT;
      line2Height.value = MIN_HEIGHT;
      line3Height.value = MIN_HEIGHT;
      return;
    }

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
  }, [volume, isMuted]);

  // Animated styles for each line
  const line1Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line1Height.value * (isMuted || volume > 0.01 ? 1 : line1Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  const line2Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line2Height.value * (isMuted || volume > 0.01 ? 1 : line2Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  const line3Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line3Height.value * (isMuted || volume > 0.01 ? 1 : line3Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  const lineColor = "#FFFFFF";
  const lineWidth = 8;

  const containerHeight = orientation === "horizontal" ? 60 : 100;

  return (
    <View style={[styles.container, { height: containerHeight }]}>
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: lineWidth,
            backgroundColor: lineColor,
          },
          line1Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: lineWidth,
            backgroundColor: lineColor,
          },
          line2Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          {
            width: lineWidth,
            backgroundColor: lineColor,
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
  },
  line: {
    borderRadius: theme.borderRadius.full,
  },
}));
