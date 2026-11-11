import { useEffect, useMemo, useRef } from "react";
import { Animated, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const ROW_KEYS = [0, 1, 2].map((i) => `pr-activity-skeleton-row-${i}`);

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

export function PrActivitySkeleton() {
  const pulse = useSkeletonPulse();

  return (
    <View style={styles.container} testID="pr-pane-activity-skeleton">
      {ROW_KEYS.map((key) => (
        <View key={key} style={styles.row}>
          <SkeletonPulse pulse={pulse} style={styles.avatar} />
          <View style={styles.lines}>
            <SkeletonPulse pulse={pulse} style={styles.lineWide} />
            <SkeletonPulse pulse={pulse} style={styles.lineNarrow} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  lines: {
    flex: 1,
    gap: theme.spacing[1],
  },
  lineWide: {
    width: "70%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  lineNarrow: {
    width: "45%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
}));
