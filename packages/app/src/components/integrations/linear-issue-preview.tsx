// LinearIssuePreview — adapted from emdash tooltip to React Native card
import { View, Text, Pressable, Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, User, Tag, Folder } from "lucide-react-native";
import type { LinearIssueSummary } from "@/types/integrations";

interface LinearIssuePreviewProps {
  issue: LinearIssueSummary;
  onClose?: () => void;
}

function StatusPill({ state }: { state?: { name?: string; color?: string } | null }) {
  if (!state?.name) return null;
  return (
    <View
      style={[pillStyles.pill, state.color ? { backgroundColor: `${state.color}20` } : undefined]}
    >
      <Text style={[pillStyles.pillText, state.color ? { color: state.color } : undefined]}>
        {state.name}
      </Text>
    </View>
  );
}

export function LinearIssuePreview({ issue, onClose }: LinearIssuePreviewProps) {
  const { theme } = useUnistyles();

  const handleOpenUrl = () => {
    if (issue.url) void Linking.openURL(issue.url);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.provider}>Linear Issue</Text>
          <Text style={styles.identifier}>{issue.identifier}</Text>
        </View>
        {issue.url ? (
          <Pressable onPress={handleOpenUrl} hitSlop={8}>
            <ExternalLink size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {issue.title || `Issue ${issue.identifier}`}
      </Text>

      {issue.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {issue.description}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <StatusPill state={issue.state} />
        {issue.assignee?.name ? (
          <View style={styles.metaItem}>
            <User size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.assignee.name}</Text>
          </View>
        ) : null}
        {issue.project?.name ? (
          <View style={styles.metaItem}>
            <Folder size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.project.name}</Text>
          </View>
        ) : null}
        {issue.team?.name ? (
          <View style={styles.metaItem}>
            <Tag size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.team.name}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const pillStyles = StyleSheet.create((theme) => ({
  pill: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
  },
  pillText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
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
  headerLeft: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  provider: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    letterSpacing: 0.5,
  },
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
  description: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, lineHeight: 16 },
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
