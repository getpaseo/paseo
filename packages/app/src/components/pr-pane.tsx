import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
} from "lucide-react-native";
import { openExternalUrl } from "@/utils/open-external-url";
import type {
  CheckStatus,
  PrPaneActivity,
  PrPaneCheck,
  PrPaneData,
  PrState,
} from "@/utils/pr-pane-data";

export function PrPane({ data }: { data: PrPaneData }) {
  const { theme } = useUnistyles();
  const [checksOpen, setChecksOpen] = useState(true);
  const [reviewsOpen, setReviewsOpen] = useState(true);

  const passed = data.checks.filter((c) => c.status === "success").length;
  const failed = data.checks.filter((c) => c.status === "failure").length;
  const pending = data.checks.filter((c) => c.status === "pending").length;

  const approvals = data.activity.filter(
    (a) => a.kind === "review" && a.reviewState === "approved",
  ).length;
  const changesRequested = data.activity.filter(
    (a) => a.kind === "review" && a.reviewState === "changes_requested",
  ).length;
  const commentCount = data.activity.filter(
    (a) => a.kind === "comment" || (a.kind === "review" && a.reviewState === "commented"),
  ).length;

  const stateColor = getStateColor(data.state, theme);
  const StateIcon = getStateIcon(data.state);
  const stateLabel = getStateLabel(data.state);

  return (
    <View style={styles.root}>
      <Pressable onPress={() => void openExternalUrl(data.url)} style={styles.header}>
        {({ hovered }) => (
          <>
            <View style={styles.stateLine}>
              <StateIcon size={14} color={stateColor} />
              <Text style={[styles.stateLabel, { color: stateColor }]}>{stateLabel}</Text>
            </View>
            <Text style={styles.title} numberOfLines={3}>
              {data.title}
              {hovered ? (
                <Text>
                  {"  "}
                  <ExternalLink size={12} color={theme.colors.foregroundMuted} />
                </Text>
              ) : null}
            </Text>
          </>
        )}
      </Pressable>

      <View style={styles.divider} />

      <Section
        title="Checks"
        open={checksOpen}
        onToggle={() => setChecksOpen((o) => !o)}
        summary={
          <>
            <SummaryPill
              count={passed}
              color={theme.colors.statusSuccess}
              icon={<CircleCheck size={12} color={theme.colors.statusSuccess} />}
            />
            <SummaryPill
              count={failed}
              color={theme.colors.statusDanger}
              icon={<CircleX size={12} color={theme.colors.statusDanger} />}
            />
            <SummaryPill
              count={pending}
              color={theme.colors.statusWarning}
              icon={<CircleDot size={12} color={theme.colors.statusWarning} />}
            />
          </>
        }
      >
        {data.checks.map((check, idx) => (
          <CheckRow key={`${check.name}-${idx}`} check={check} />
        ))}
      </Section>

      <View style={styles.divider} />

      <Section
        title="Reviews"
        open={reviewsOpen}
        onToggle={() => setReviewsOpen((o) => !o)}
        summary={
          <>
            <SummaryPill
              count={approvals}
              color={theme.colors.statusSuccess}
              icon={<CircleCheck size={12} color={theme.colors.statusSuccess} />}
            />
            <SummaryPill
              count={changesRequested}
              color={theme.colors.statusDanger}
              icon={<CircleX size={12} color={theme.colors.statusDanger} />}
            />
            <SummaryPill
              count={commentCount}
              color={theme.colors.foregroundMuted}
              icon={<MessageSquare size={11} color={theme.colors.foregroundMuted} />}
            />
          </>
        }
      >
        {data.activity.map((item, idx) => (
          <ActivityRow key={`${item.author}-${idx}`} item={item} />
        ))}
      </Section>
    </View>
  );
}

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, open, onToggle, summary, children }: SectionProps) {
  const { theme } = useUnistyles();
  return (
    <View style={open ? styles.sectionOpen : undefined}>
      <Pressable style={styles.sectionHeader} onPress={onToggle}>
        {open ? (
          <ChevronDown size={14} color={theme.colors.foregroundMuted} />
        ) : (
          <ChevronRight size={14} color={theme.colors.foregroundMuted} />
        )}
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.summaryWrap}>{summary}</View>
      </Pressable>
      {open && (
        <ScrollView
          style={styles.sectionBody}
          contentContainerStyle={styles.sectionBodyContent}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      )}
    </View>
  );
}

function SummaryPill({
  count,
  color,
  icon,
}: {
  count: number;
  color: string;
  icon: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <View style={styles.summaryPill}>
      {icon}
      <Text style={[styles.summaryPillText, { color }]}>{count}</Text>
    </View>
  );
}

function CheckRow({ check }: { check: PrPaneCheck }) {
  return (
    <Pressable
      onPress={() => void openExternalUrl(check.url)}
      style={({ hovered }) => [styles.row, hovered && styles.hoverable]}
    >
      <CheckStatusIcon status={check.status} />
      <Text style={styles.rowTitle} numberOfLines={1}>
        {check.name}
      </Text>
      {check.workflow && (
        <Text style={styles.rowMetaMid} numberOfLines={1}>
          {check.workflow}
        </Text>
      )}
      {check.duration && <Text style={styles.rowMeta}>{check.duration}</Text>}
    </Pressable>
  );
}

function CheckStatusIcon({ status }: { status: CheckStatus }) {
  const { theme } = useUnistyles();
  if (status === "success") return <CircleCheck size={14} color={theme.colors.statusSuccess} />;
  if (status === "failure") return <CircleX size={14} color={theme.colors.statusDanger} />;
  if (status === "pending") return <CircleDot size={14} color={theme.colors.statusWarning} />;
  return <CircleSlash size={14} color={theme.colors.foregroundMuted} />;
}

function ActivityRow({ item }: { item: PrPaneActivity }) {
  const verb = getActivityVerb(item);
  return (
    <Pressable
      onPress={() => void openExternalUrl(item.url)}
      style={({ hovered }) => [styles.activityRow, hovered && styles.hoverable]}
    >
      <View style={[styles.avatar, { backgroundColor: item.avatarColor }]}>
        <Text style={styles.avatarText}>{item.author.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.activityMain}>
        <View style={styles.activityHeader}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.author}
          </Text>
          <Text style={styles.rowMetaMid}>{verb}</Text>
          <Text style={styles.rowMeta}>{item.age}</Text>
        </View>
        <Text style={styles.rowBody} numberOfLines={2}>
          {item.body}
        </Text>
      </View>
    </Pressable>
  );
}

function getActivityVerb(item: PrPaneActivity): string {
  if (item.kind === "comment") return "Commented";
  if (item.reviewState === "approved") return "Approved";
  if (item.reviewState === "changes_requested") return "Requested changes";
  return "Reviewed";
}

function getStateColor(state: PrState, theme: ReturnType<typeof useUnistyles>["theme"]): string {
  if (state === "open") return theme.colors.statusSuccess;
  if (state === "draft") return theme.colors.foregroundMuted;
  if (state === "merged") return theme.colors.statusMerged;
  return theme.colors.statusDanger;
}

function getStateIcon(state: PrState) {
  if (state === "draft") return GitPullRequestDraft;
  if (state === "merged") return GitMerge;
  if (state === "closed") return GitPullRequestClosed;
  return GitPullRequest;
}

function getStateLabel(state: PrState): string {
  if (state === "draft") return "Draft";
  if (state === "merged") return "Merged";
  if (state === "closed") return "Closed";
  return "Open";
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  hoverable: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  header: {
    flexDirection: "column",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  stateLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  stateLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    lineHeight: 19,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  sectionOpen: {
    flexShrink: 1,
    minHeight: 0,
  },
  sectionBody: {
    flexShrink: 1,
    minHeight: 0,
  },
  sectionBodyContent: {
    paddingBottom: theme.spacing[3],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  summaryWrap: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  summaryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  summaryPillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  activityRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  activityMain: { flex: 1, minWidth: 0, gap: 2 },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginLeft: "auto",
  },
  rowMetaMid: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  rowBody: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  avatarText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.normal,
    color: "#fff",
  },
}));
