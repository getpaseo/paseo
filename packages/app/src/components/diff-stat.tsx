import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatDiffCount } from "@/git/file-header-presentation";

interface DiffStatProps {
  additions: number;
  deletions: number;
  testID?: string;
  exact?: boolean;
  muted?: boolean;
}

export function DiffStat({
  additions,
  deletions,
  testID,
  exact = false,
  muted = false,
}: DiffStatProps) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <View style={styles.row} testID={testID}>
      {additions !== 0 && (
        <Text style={[styles.additions, muted && styles.muted]}>
          +{exact ? additions.toLocaleString() : formatDiffCount(additions)}
        </Text>
      )}
      {deletions !== 0 && (
        <Text style={[styles.deletions, muted && styles.muted]}>
          -{exact ? deletions.toLocaleString() : formatDiffCount(deletions)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: { color: theme.colors.foregroundMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: 20,
    gap: 4,
    flexShrink: 0,
  },
  additions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  deletions: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
}));
