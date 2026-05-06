import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface DiffStatProps {
  additions: number;
  deletions: number;
}

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatDiffCount(value: number): string {
  return compactFormatter.format(value).toLowerCase();
}

export function DiffStat({ additions, deletions }: DiffStatProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.additions}>+{formatDiffCount(additions)}</Text>
      <Text style={styles.deletions}>-{formatDiffCount(deletions)}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  additions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  deletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
  },
}));
