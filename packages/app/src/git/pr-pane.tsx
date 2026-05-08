import { useCallback, useMemo, useState } from "react";
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
import { getActivityVerb, getStateLabel } from "@/git/pr-pane-data";
import type {
  CheckStatus,
  PrPaneActivity,
  PrPaneCheck,
  PrPaneData,
  PrState,
} from "@/git/pr-pane-data";

function rowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, Boolean(hovered) && styles.hoverable];
}

function activityPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.activityRow, Boolean(hovered) && styles.hoverable];
}

export function PrPane({ data }: { data: PrPaneData }) {
  const { theme } = useUnistyles();
  const [checksOpen, setChecksOpen] = useState(true);
  const [reviewsOpen, setReviewsOpen] = useState(true);

  const handleOpenPrUrl = useCallback(() => {
    void openExternalUrl(data.url);
  }, [data.url]);

  const handleToggleChecks = useCallback(() => {
    setChecksOpen((o) => !o);
  }, []);

  const handleToggleReviews = useCallback(() => {
    setReviewsOpen((o) => !o);
  }, []);

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
  const stateLabelStyle = useMemo(() => [styles.stateLabel, { color: stateColor }], [stateColor]);
  const keyedActivity = useMemo(
    () => data.activity.map((item, idx) => ({ key: `${item.author}-${item.kind}-${idx}`, item })),
    [data.activity],
  );

  const checkSuccessIcon = useMemo(
    () => <CircleCheck size={12} color={theme.colors.statusSuccess} />,
    [theme.colors.statusSuccess],
  );
  const checkDangerIcon = useMemo(
    () => <CircleX size={12} color={theme.colors.statusDanger} />,
    [theme.colors.statusDanger],
  );
  const checkWarningIcon = useMemo(
    () => <CircleDot size={12} color={theme.colors.statusWarning} />,
    [theme.colors.statusWarning],
  );
  const commentIcon = useMemo(
    () => <MessageSquare size={11} color={theme.colors.foregroundMuted} />,
    [theme.colors.foregroundMuted],
  );

  return (
    <View style={styles.root} testID="pr-pane">
      <Pressable onPress={handleOpenPrUrl} style={styles.header}>
        {({ hovered }) => (
          <>
            <View style={styles.stateLine}>
              <StateIcon size={14} color={stateColor} />
              <Text style={stateLabelStyle} testID="pr-pane-state">
                {stateLabel}
              </Text>
            </View>
            <Text style={styles.title} numberOfLines={3} testID="pr-pane-title">
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
        onToggle={handleToggleChecks}
        summary={
          <>
            <SummaryPill
              count={passed}
              color={theme.colors.statusSuccess}
              icon={checkSuccessIcon}
              testID="pr-pane-check-passed"
            />
            <SummaryPill
              count={failed}
              color={theme.colors.statusDanger}
              icon={checkDangerIcon}
              testID="pr-pane-check-failed"
            />
            <SummaryPill
              count={pending}
              color={theme.colors.statusWarning}
              icon={checkWarningIcon}
              testID="pr-pane-check-pending"
            />
          </>
        }
      >
        {data.checks.map((check) => (
          <CheckRow key={check.name} check={check} />
        ))}
      </Section>

      <View style={styles.divider} />

      <Section
        title="Reviews"
        open={reviewsOpen}
        onToggle={handleToggleReviews}
        summary={
          <>
            <SummaryPill
              count={approvals}
              color={theme.colors.statusSuccess}
              icon={checkSuccessIcon}
            />
            <SummaryPill
              count={changesRequested}
              color={theme.colors.statusDanger}
              icon={checkDangerIcon}
            />
            <SummaryPill
              count={commentCount}
              color={theme.colors.foregroundMuted}
              icon={commentIcon}
            />
          </>
        }
      >
        {keyedActivity.map(({ key, item }) => (
          <ActivityRow key={key} item={item} />
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
  testID,
}: {
  count: number;
  color: string;
  icon: React.ReactNode;
  testID?: string;
}) {
  const textStyle = useMemo(() => [styles.summaryPillText, { color }], [color]);
  if (count === 0) return null;
  return (
    <View style={styles.summaryPill} testID={testID}>
      {icon}
      <Text style={textStyle}>{count}</Text>
    </View>
  );
}

function CheckRow({ check }: { check: PrPaneCheck }) {
  const handlePress = useCallback(() => {
    void openExternalUrl(check.url);
  }, [check.url]);
  return (
    <Pressable onPress={handlePress} style={rowPressableStyle}>
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
  const handlePress = useCallback(() => {
    void openExternalUrl(item.url);
  }, [item.url]);
  const avatarStyle = useMemo(
    () => [styles.avatar, { backgroundColor: item.avatarColor }],
    [item.avatarColor],
  );
  return (
    <Pressable onPress={handlePress} style={activityPressableStyle} testID="pr-pane-activity-row">
      <View style={avatarStyle}>
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
