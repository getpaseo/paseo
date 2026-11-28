import { useMemo } from "react";
import { View, type Animated } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { settingsStyles } from "@/styles/settings";

const ROWS = [0, 1, 2, 3];
const LINES = [0, 1, 2];

function RowSkeleton({ pulse }: { pulse: Animated.Value }) {
  const rowStyle = useMemo(() => [settingsStyles.row, styles.row], []);
  return (
    <View style={rowStyle}>
      <SkeletonPulse pulse={pulse} style={styles.tile} />
      <View style={styles.text}>
        <SkeletonPulse pulse={pulse} style={styles.title} />
        <SkeletonPulse pulse={pulse} style={styles.line} />
      </View>
      <SkeletonPulse pulse={pulse} style={styles.control} />
    </View>
  );
}

/** A card of plugin rows while the list or the directory loads. */
export function PluginRowsSkeleton({ testID }: { testID?: string }) {
  const pulse = useSkeletonPulse();
  return (
    <SettingsCard testID={testID}>
      {ROWS.map((row) => (
        <RowSkeleton key={row} pulse={pulse} />
      ))}
    </SettingsCard>
  );
}

/** Lines of text in a card, where the overview will be. */
export function OverviewSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <SettingsCard>
      <View style={styles.overview}>
        {LINES.map((line) => (
          <SkeletonPulse key={line} pulse={pulse} style={line === 2 ? styles.short : styles.line} />
        ))}
      </View>
    </SettingsCard>
  );
}

/** The plugin page's header and description before anything about the plugin is known. */
export function PluginPageSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View testID="plugin-page-skeleton">
      <View style={styles.header}>
        <SkeletonPulse pulse={pulse} style={styles.tileLarge} />
        <View style={styles.text}>
          <SkeletonPulse pulse={pulse} style={styles.name} />
          <SkeletonPulse pulse={pulse} style={styles.title} />
        </View>
        <SkeletonPulse pulse={pulse} style={styles.control} />
      </View>
      <View style={styles.description}>
        <SkeletonPulse pulse={pulse} style={styles.line} />
        <SkeletonPulse pulse={pulse} style={styles.short} />
      </View>
    </View>
  );
}

// The shapes take the size of what they stand for: a row's tile and text, the page's large tile and
// name, and a button.
const styles = StyleSheet.create((theme) => {
  const shape = { backgroundColor: theme.colors.surface2, borderRadius: theme.borderRadius.sm };
  return {
    row: { gap: theme.spacing[3] },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
      marginBottom: theme.spacing[4],
    },
    text: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
    tile: {
      ...shape,
      width: theme.spacing[8],
      height: theme.spacing[8],
      borderRadius: theme.borderRadius.lg,
    },
    tileLarge: {
      ...shape,
      width: theme.spacing[12],
      height: theme.spacing[12],
      borderRadius: theme.borderRadius.xl,
    },
    name: { ...shape, width: 180, height: theme.fontSize.xl },
    title: { ...shape, width: 140, height: theme.fontSize.sm },
    line: { ...shape, width: "100%", maxWidth: 420, height: theme.fontSize.sm },
    short: { ...shape, width: "60%", maxWidth: 260, height: theme.fontSize.sm },
    control: { ...shape, width: 72, height: 28, borderRadius: theme.borderRadius.md },
    overview: { padding: theme.spacing[4], gap: theme.spacing[3] },
    description: { gap: theme.spacing[2], marginBottom: theme.spacing[6] },
  };
});
