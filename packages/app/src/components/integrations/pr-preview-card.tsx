// PrPreviewCard — adapted from emdash's PrPreviewTooltip for React Native
import { View, Text, Pressable, Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, GitPullRequest, FileDiff, Plus, Minus } from "lucide-react-native";

interface PrPreviewCardProps {
  pr: {
    number: number;
    title: string;
    state?: string;
    url?: string;
    additions?: number;
    deletions?: number;
    changedFiles?: number;
    draft?: boolean;
  };
}

function StatePill({ state, draft }: { state?: string; draft?: boolean }) {
  if (!state) return null;
  const label = draft ? "Draft" : state;
  const isOpen = state.toLowerCase() === "open";
  const isMerged = state.toLowerCase() === "merged";
  return (
    <View
      style={[
        pillStyles.pill,
        isOpen && pillStyles.open,
        isMerged && pillStyles.merged,
        !isOpen && !isMerged && pillStyles.closed,
      ]}
    >
      <Text
        style={[
          pillStyles.text,
          isOpen && pillStyles.openText,
          isMerged && pillStyles.mergedText,
          !isOpen && !isMerged && pillStyles.closedText,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

export function PrPreviewCard({ pr }: PrPreviewCardProps) {
  const { theme } = useUnistyles();

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <GitPullRequest size={12} color={theme.colors.foregroundMuted} />
          <Text style={styles.identifier}>#{pr.number}</Text>
        </View>
        {pr.url ? (
          <Pressable onPress={() => void Linking.openURL(pr.url!)} hitSlop={8}>
            <ExternalLink size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {pr.title}
      </Text>

      <View style={styles.metaRow}>
        <StatePill state={pr.state} draft={pr.draft} />
        {pr.changedFiles != null ? (
          <View style={styles.metaItem}>
            <FileDiff size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{pr.changedFiles} files</Text>
          </View>
        ) : null}
        {pr.additions != null ? (
          <View style={styles.metaItem}>
            <Plus size={10} color="#22c55e" />
            <Text style={[styles.metaText, { color: "#22c55e" }]}>{pr.additions}</Text>
          </View>
        ) : null}
        {pr.deletions != null ? (
          <View style={styles.metaItem}>
            <Minus size={10} color="#ef4444" />
            <Text style={[styles.metaText, { color: "#ef4444" }]}>{pr.deletions}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const pillStyles = StyleSheet.create((theme) => ({
  pill: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  text: { fontSize: 10, fontWeight: theme.fontWeight.medium },
  open: { backgroundColor: "rgba(59,130,246,0.1)" },
  openText: { color: "#3b82f6" },
  merged: { backgroundColor: "rgba(168,85,247,0.1)" },
  mergedText: { color: "#a855f7" },
  closed: { backgroundColor: "rgba(16,185,129,0.1)" },
  closedText: { color: "#10b981" },
}));

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  identifier: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  metaText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
