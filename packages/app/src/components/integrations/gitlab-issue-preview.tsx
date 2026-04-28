// GitLabIssuePreview — adapted from emdash tooltip to React Native card
import { View, Text, Pressable, Linking } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, User, Folder, Tag } from "lucide-react-native";
import type { GitLabIssueSummary } from "@/types/integrations";

interface GitLabIssuePreviewProps {
  issue: GitLabIssueSummary;
}

function StatusPill({ state }: { state?: string | null }) {
  if (!state) return null;
  const isOpen = state.toLowerCase() === "opened";
  return (
    <View style={[pillStyles.pill, isOpen ? pillStyles.open : pillStyles.closed]}>
      <Text style={[pillStyles.text, isOpen ? pillStyles.openText : pillStyles.closedText]}>
        {state}
      </Text>
    </View>
  );
}

export function GitLabIssuePreview({ issue }: GitLabIssuePreviewProps) {
  const { theme } = useUnistyles();

  const handleOpenUrl = () => {
    if (issue.webUrl) void Linking.openURL(issue.webUrl);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.provider}>GitLab Issue</Text>
          <Text style={styles.identifier}>#{issue.iid}</Text>
        </View>
        {issue.webUrl ? (
          <Pressable onPress={handleOpenUrl} hitSlop={8}>
            <ExternalLink size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {issue.title || `Issue #${issue.iid}`}
      </Text>

      {issue.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {issue.description}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <StatusPill state={issue.state} />
        {issue.assignees && issue.assignees.length > 0 ? (
          <View style={styles.metaItem}>
            <User size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>
              {issue.assignees
                .map((a) => a.name || a.username)
                .filter(Boolean)
                .slice(0, 2)
                .join(", ")}
            </Text>
          </View>
        ) : null}
        {issue.projectPath ? (
          <View style={styles.metaItem}>
            <Folder size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>{issue.projectPath}</Text>
          </View>
        ) : null}
        {issue.labels && issue.labels.length > 0 ? (
          <View style={styles.metaItem}>
            <Tag size={10} color={theme.colors.foregroundMuted} />
            <Text style={styles.metaText}>
              {issue.labels.slice(0, 2).join(", ")}
              {issue.labels.length > 2 ? ` +${issue.labels.length - 2}` : ""}
            </Text>
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
