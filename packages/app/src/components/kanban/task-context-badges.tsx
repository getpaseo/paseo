// TaskContextBadges — adapted from emdash's TaskContextBadges.tsx
// Shows badges for linked issues (Linear, GitHub, Jira, GitLab, Forgejo, Plain)

import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink } from "lucide-react-native";
import * as WebBrowser from "expo-web-browser";
import type {
  LinearIssueSummary,
  GitHubIssueSummary,
  JiraIssueSummary,
  GitLabIssueSummary,
  PlainThreadSummary,
  ForgejoIssueSummary,
} from "@/types/integrations";

interface TaskContextBadgesProps {
  linearIssue?: LinearIssueSummary | null;
  githubIssue?: GitHubIssueSummary | null;
  jiraIssue?: JiraIssueSummary | null;
  gitlabIssue?: GitLabIssueSummary | null;
  plainThread?: PlainThreadSummary | null;
  forgejoIssue?: ForgejoIssueSummary | null;
}

function IssueBadge({
  label,
  identifier,
  url,
}: {
  label: string;
  identifier: string;
  url?: string | null;
}) {
  const { theme } = useUnistyles();

  const handlePress = useCallback(() => {
    if (url) {
      void WebBrowser.openBrowserAsync(url);
    }
  }, [url]);

  return (
    <Pressable
      style={({ pressed }) => [badgeStyles.badge, pressed && badgeStyles.badgePressed]}
      onPress={handlePress}
      disabled={!url}
    >
      <Text style={badgeStyles.badgeLabel}>{label}</Text>
      <Text style={badgeStyles.badgeIdentifier}>{identifier}</Text>
      {url ? <ExternalLink size={10} color={theme.colors.foregroundMuted} /> : null}
    </Pressable>
  );
}

export function TaskContextBadges({
  linearIssue,
  githubIssue,
  jiraIssue,
  gitlabIssue,
  plainThread,
  forgejoIssue,
}: TaskContextBadgesProps) {
  const hasBadges =
    linearIssue || githubIssue || jiraIssue || gitlabIssue || plainThread || forgejoIssue;

  if (!hasBadges) return null;

  return (
    <View style={badgeStyles.container}>
      {linearIssue ? (
        <IssueBadge label="Linear" identifier={linearIssue.identifier} url={linearIssue.url} />
      ) : null}
      {githubIssue ? (
        <IssueBadge label="GitHub" identifier={`#${githubIssue.number}`} url={githubIssue.url} />
      ) : null}
      {jiraIssue ? (
        <IssueBadge label="Jira" identifier={jiraIssue.key} url={jiraIssue.url} />
      ) : null}
      {gitlabIssue ? (
        <IssueBadge label="GitLab" identifier={`#${gitlabIssue.iid}`} url={gitlabIssue.webUrl} />
      ) : null}
      {plainThread ? <IssueBadge label="Plain" identifier={plainThread.title} /> : null}
      {forgejoIssue ? (
        <IssueBadge
          label="Forgejo"
          identifier={`#${forgejoIssue.number}`}
          url={forgejoIssue.htmlUrl}
        />
      ) : null}
    </View>
  );
}

const badgeStyles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  badgePressed: {
    opacity: 0.7,
  },
  badgeLabel: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  badgeIdentifier: {
    fontSize: 10,
    color: theme.colors.foreground,
  },
}));
