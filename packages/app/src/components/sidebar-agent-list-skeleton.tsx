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
    outputRange: [0.4, 0.8],
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
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );

    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <View style={styles.container}>
      {[1, 0.7, 0.4].map((sectionOpacity, sectionIdx) => (
        <View
          key={`skeleton-section-${sectionIdx}`}
          style={[styles.section, { opacity: sectionOpacity }]}
        >
          <View style={styles.sectionHeader}>
            <SkeletonPulse pulse={pulse} style={styles.chevron} />
            <SkeletonPulse pulse={pulse} style={styles.projectIcon} />
            <SkeletonPulse pulse={pulse} style={styles.sectionTitle} />
          </View>

          <View style={styles.rows}>
            {Array.from({ length: 3 }).map((__, rowIdx) => (
              <View
                key={`skeleton-row-${sectionIdx}-${rowIdx}`}
                style={styles.row}
              >
                <SkeletonPulse pulse={pulse} style={styles.rowDot} />
                <SkeletonPulse pulse={pulse} style={styles.rowTitle} />
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
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  section: {
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  chevron: {
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  projectIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  sectionTitle: {
    width: "45%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  rows: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  rowTitle: {
    flex: 1,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  rowBadge: {
    width: 40,
    height: 20,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
}));
