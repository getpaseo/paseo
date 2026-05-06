import { useEffect, useMemo, useRef } from "react";
import { Animated, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const SECTION_OPACITIES: readonly number[] = [1, 0.7, 0.4];
const SECTION_KEYS = SECTION_OPACITIES.map((_, i) => `skeleton-section-${i}`);
const ROW_KEYS_BY_SECTION: readonly (readonly string[])[] = SECTION_OPACITIES.map((_, sIdx) =>
  [0, 1, 2].map((r) => `skeleton-row-${sIdx}-${r}`),
);

function SkeletonPulse({ pulse, style }: { pulse: Animated.Value; style: StyleProp<ViewStyle> }) {
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.8],
  });

  const pulseStyle = useMemo(() => [style, { opacity }], [style, opacity]);

  return <Animated.View style={pulseStyle} />;
}

function SkeletonSection({
  pulse,
  sectionOpacity,
  sectionIdx,
}: {
  pulse: Animated.Value;
  sectionOpacity: number;
  sectionIdx: number;
}) {
  const sectionStyle = useMemo(
    () => [styles.section, { opacity: sectionOpacity }],
    [sectionOpacity],
  );
  return (
    <View style={sectionStyle}>
      <View style={styles.sectionHeader}>
        <SkeletonPulse pulse={pulse} style={styles.chevron} />
        <SkeletonPulse pulse={pulse} style={styles.projectIcon} />
        <SkeletonPulse pulse={pulse} style={styles.sectionTitle} />
      </View>

      <View style={styles.rows}>
        {ROW_KEYS_BY_SECTION[sectionIdx]?.map((key) => (
          <View key={key} style={styles.row}>
            <SkeletonPulse pulse={pulse} style={styles.rowDot} />
            <SkeletonPulse pulse={pulse} style={styles.rowTitle} />
            <SkeletonPulse pulse={pulse} style={styles.rowBadge} />
          </View>
        ))}
      </View>
    </View>
  );
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
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <View style={styles.container}>
      {SECTION_OPACITIES.map((sectionOpacity, sectionIdx) => (
        <SkeletonSection
          key={SECTION_KEYS[sectionIdx]}
          pulse={pulse}
          sectionOpacity={sectionOpacity}
          sectionIdx={sectionIdx}
        />
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
