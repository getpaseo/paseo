import { useEffect, useRef } from "react";
import { Animated, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

function SkeletonPulse({
  pulse,
  style,
}: {
  pulse: Animated.Value;
  style: StyleProp<ViewStyle>;
}) {
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.45, 0.95],
  });

  return <Animated.View style={[style, { opacity }]} />;
}

export function SidebarAgentListSkeleton() {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 850,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 850,
          useNativeDriver: true,
        }),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <View style={styles.container}>
      {Array.from({ length: 4 }).map((_, sectionIdx) => (
        <View key={`skeleton-section-${sectionIdx}`} style={styles.section}>
          <View style={styles.sectionHeader}>
            <SkeletonPulse pulse={pulse} style={styles.projectIcon} />
            <SkeletonPulse pulse={pulse} style={styles.sectionTitle} />
          </View>

          <View style={styles.rows}>
            {Array.from({ length: 3 }).map((__, rowIdx) => (
              <View key={`skeleton-row-${sectionIdx}-${rowIdx}`} style={styles.row}>
                <SkeletonPulse pulse={pulse} style={styles.rowDot} />
                <View style={styles.rowText}>
                  <SkeletonPulse pulse={pulse} style={styles.rowTitle} />
                </View>
                <SkeletonPulse pulse={pulse} style={styles.rowBadge} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[4],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    shadowColor: theme.colors.foreground,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  sectionTitle: {
    width: "52%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    shadowColor: theme.colors.foreground,
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  rows: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    width: "70%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  rowBadge: {
    width: 46,
    height: 18,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
}));
