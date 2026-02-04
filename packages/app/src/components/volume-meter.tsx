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
  variant?: "default" | "compact";
  color?: string;
}

export function VolumeMeter({
  volume,
  isMuted = false,
  isDetecting = false,
  isSpeaking = false,
  orientation = "vertical",
  variant = "default",
  color,
}: VolumeMeterProps) {
  const { theme } = useUnistyles();
  const isCompact = variant === "compact";

  // Base dimensions
  const LINE_SPACING = isCompact ? 6 : 8;
  const LINE_WIDTH = isCompact ? 6 : 8;
  const MAX_HEIGHT =
    orientation === "horizontal" ? (isCompact ? 18 : 30) : isCompact ? 32 : 50;
  const MIN_HEIGHT =
    orientation === "horizontal" ? (isCompact ? 8 : 12) : isCompact ? 14 : 20;

  // Create shared values for 3 dots unconditionally
  const line1Height = useSharedValue(MIN_HEIGHT);
  const line2Height = useSharedValue(MIN_HEIGHT);
  const line3Height = useSharedValue(MIN_HEIGHT);
  const line1Pulse = useSharedValue(1);
  const line2Pulse = useSharedValue(1);
  const line3Pulse = useSharedValue(1);

  // Start idle animations with different phases for all dots
  useEffect(() => {
    if (isMuted) {
      // When muted, set all pulses to 1 (no animation)
      line1Pulse.value = 1;
      line2Pulse.value = 1;
      line3Pulse.value = 1;
      return;
    }

    // Animate each dot with different phases and durations
    line1Pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 0 }),
        withTiming(1.15, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );

    line2Pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 200 }),
        withTiming(1.20, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );

    line3Pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 400 }),
        withTiming(1.25, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, [isMuted]);

  // Update heights based on volume with different responsiveness for all dots
  useEffect(() => {
    if (isMuted) {
      // When muted, keep all lines at minimum height without animation
      line1Height.value = MIN_HEIGHT;
      line2Height.value = MIN_HEIGHT;
      line3Height.value = MIN_HEIGHT;
      return;
    }

    if (volume > 0.001) {
      // Active volume - animate heights based on volume
      const target1 = MIN_HEIGHT + (MAX_HEIGHT * volume * 1.2);
      const target2 = MIN_HEIGHT + (MAX_HEIGHT * volume * 1.05);
      const target3 = MIN_HEIGHT + (MAX_HEIGHT * volume * 0.9);

      line1Height.value = withSpring(target1, {
        damping: 10,
        stiffness: 200,
      });

      line2Height.value = withSpring(target2, {
        damping: 12.5,
        stiffness: 175,
      });

      line3Height.value = withSpring(target3, {
        damping: 15,
        stiffness: 150,
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

  const lineColor = color ?? theme.colors.foreground;
  const containerHeight =
    orientation === "horizontal" ? (isCompact ? 32 : 60) : isCompact ? 64 : 100;

  // Create animated styles unconditionally at top level
  const line1Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line1Height.value * (isMuted || volume > 0.001 ? 1 : line1Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  const line2Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line2Height.value * (isMuted || volume > 0.001 ? 1 : line2Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  const line3Style = useAnimatedStyle(() => {
    const isActive = isDetecting || isSpeaking;
    const baseOpacity = isMuted ? 0.3 : isActive ? 0.9 : 0.5;
    const volumeBoost = isMuted ? 0 : volume * 0.3;
    return {
      height: line3Height.value * (isMuted || volume > 0.001 ? 1 : line3Pulse.value),
      opacity: baseOpacity + volumeBoost,
    };
  });

  return (
    <View style={[styles.container, { height: containerHeight }]}>
      <ReanimatedAnimated.View
        style={[
          styles.line,
          { width: LINE_WIDTH, backgroundColor: lineColor },
          line1Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          { width: LINE_WIDTH, backgroundColor: lineColor },
          line2Style,
        ]}
      />
      <View style={{ width: LINE_SPACING }} />
      <ReanimatedAnimated.View
        style={[
          styles.line,
          { width: LINE_WIDTH, backgroundColor: lineColor },
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
