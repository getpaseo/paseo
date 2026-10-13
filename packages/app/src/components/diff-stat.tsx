import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatDiffCount } from "@/git/file-header-presentation";

interface DiffStatProps {
  additions: number;
  deletions: number;
  testID?: string;
}

function shortCommit(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

export function DiffStat({ additions, deletions, testID }: DiffStatProps) {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.additions}>+{formatDiffCount(additions)}</Text>
      <Text style={styles.deletions}>-{formatDiffCount(deletions)}</Text>
    </View>
  );
}

interface SubmoduleStatProps {
  oldCommit: string | null;
  newCommit: string | null;
  isDirty?: boolean;
  testID?: string;
}

export function SubmoduleStat({ oldCommit, newCommit, isDirty, testID }: SubmoduleStatProps) {
  const oldShort = shortCommit(oldCommit);
  const newShort = shortCommit(newCommit);
  return (
    <View style={styles.row} testID={testID}>
      {newShort ? <Text style={styles.additions}>+{newShort}</Text> : null}
      {oldShort ? <Text style={styles.deletions}>-{oldShort}</Text> : null}
      {isDirty ? <Text style={styles.dirty}>+dirty</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  dirty: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusWarning,
  },
}));
