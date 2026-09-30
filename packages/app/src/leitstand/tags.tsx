import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink } from "@/components/ui/external-link";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { buildJiraIssueUrl } from "./jira";
import { useJiraSite } from "./preferences-store";
import { projectMonogram, type LeitstandPullRequest } from "./session-model";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";

export function ProjectTag({ name }: { name: string }) {
  return (
    <Text dataSet={MONO_FONT_DATASET} style={styles.projectTag} accessibilityLabel={name}>
      {projectMonogram(name)}
    </Text>
  );
}

/** Ticket keys as links to the configured Jira site, or as plain text when none is set. */
export function JiraTags({ keys, testID }: { keys: readonly string[]; testID: string }) {
  const site = useJiraSite();
  if (keys.length === 0) return null;
  return (
    <View style={styles.row}>
      {keys.map((key) =>
        site ? (
          <ExternalLink
            key={key}
            href={buildJiraIssueUrl(site, key)}
            label={key}
            testID={`${testID}-jira-${key}`}
          />
        ) : (
          <Text
            dataSet={MONO_FONT_DATASET}
            key={key}
            style={styles.mono}
            testID={`${testID}-jira-${key}`}
          >
            {key}
          </Text>
        ),
      )}
    </View>
  );
}

/** One cell per change request in stack order, merged ones filled. */
export function StackBar({ pullRequests }: { pullRequests: readonly LeitstandPullRequest[] }) {
  return (
    <View style={styles.stackBar}>
      {pullRequests.map((pr) => (
        <View
          key={pr.number}
          style={
            pr.state === "merged" ? [styles.stackCell, styles.stackCellMerged] : styles.stackCell
          }
        />
      ))}
    </View>
  );
}

export function AgeText({ date }: { date: Date | null }) {
  const label = useCompactTimeAgo(date);
  return label ? (
    <Text dataSet={MONO_FONT_DATASET} style={styles.mono}>
      {label}
    </Text>
  ) : null;
}

const styles = StyleSheet.create((theme) => ({
  projectTag: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1],
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  stackBar: {
    flexDirection: "row",
    gap: 1,
    alignItems: "center",
  },
  stackCell: {
    width: 5,
    height: 9,
    backgroundColor: theme.colors.surface4,
  },
  stackCellMerged: {
    backgroundColor: theme.colors.statusMerged,
  },
}));
