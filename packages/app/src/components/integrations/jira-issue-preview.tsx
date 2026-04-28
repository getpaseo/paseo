// JiraIssuePreview — adapted from emdash tooltip to React Native card
import { View, Text, Pressable, Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, User, Folder } from "lucide-react-native";
import type { JiraIssueSummary } from "@/types/integrations";

interface JiraIssuePreviewProps {
  issue: JiraIssueSummary;
}

function StatusPill({ status }: { status?: { name?: string } | null }) {
  if (!status?.name) return null;
  const name = status.name.toLowerCase();
  const isDone = name.includes("done") || name.includes("closed") || name.includes("resolved");
  const isProgress = name.includes("progress") || name.includes("review");
  const isBlocked = name.includes("blocked") || name.includes("cancelled");

  return (
    <View
      style={[
        pillStyles.pill,
        isDone && pillStyles.done,
        isProgress && pillStyles.progress,
        isBlocked && pillStyles.blocked,
      ]}
    >
      <Text
        style={[
          pillStyles.text,
          isDone && pillStyles.doneText,
          isProgress && pillStyles.progressText,
          isBlocked && pillStyles.blockedText,
        ]}
      >
        {status.name}
      </Text>
    </View>
  );
}

export function JiraIssuePreview({ issue }: JiraIssuePreviewProps) {
  const { theme } = useUnistyles();

  const handleOpenUrl = () => {
    if (issue.url) void Linking.openURL(issue.url);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.provider}>Jira Issue</Text>
          <Text style={styles.identifier}>{issue.key}</Text>
        </View>
        {issue.url ? (
          <Pressable onPress={handleOpenUrl} hitSlop={8}>
            <ExternalLink size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {issue.title || `Issue ${issue.key}`}
      </Text>

      {issue.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {issue.description}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <StatusPill status={issue.status} />
        {issue.assignee?.name ? (
          <View style={styles.metaItem}>
            <User size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.assignee.name}</Text>
          </View>
        ) : null}
        {issue.projectKey ? (
          <View style={styles.metaItem}>
            <Folder size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.projectKey}</Text>
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
  text: { fontSize: 10, fontWeight: theme.fontWeight.medium, color: theme.colors.foregroundMuted },
  done: { backgroundColor: "rgba(16,185,129,0.1)" },
  doneText: { color: "#10b981" },
  progress: { backgroundColor: "rgba(59,130,246,0.1)" },
  progressText: { color: "#3b82f6" },
  blocked: { backgroundColor: "rgba(244,63,94,0.1)" },
  blockedText: { color: "#f43f5e" },
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
