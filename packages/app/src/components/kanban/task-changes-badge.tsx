// TaskChangesBadge — adapted from emdash's TaskChanges.tsx
// Shows additions/deletions count

import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface TaskChangesBadgeProps {
  additions: number;
  deletions: number;
}

export function TaskChangesBadge({ additions, deletions }: TaskChangesBadgeProps) {
  if (additions === 0 && deletions === 0) return null;

  return (
    <View style={badgeStyles.container}>
      {additions > 0 ? <Text style={badgeStyles.additions}>+{additions}</Text> : null}
      {deletions > 0 ? <Text style={badgeStyles.deletions}>-{deletions}</Text> : null}
    </View>
  );
}

const badgeStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  additions: {
    fontSize: 11,
    color: "#22c55e",
    fontWeight: theme.fontWeight.medium,
  },
  deletions: {
    fontSize: 11,
    color: "#ef4444",
    fontWeight: theme.fontWeight.medium,
  },
}));
