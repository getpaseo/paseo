import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View, type GestureResponderEvent } from "react-native";
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
import { Button } from "@/components/ui/button";
import { SharedMarkdownRenderer } from "@/components/markdown/renderer";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  appendWorkspaceAttachment,
  useWorkspaceAttachments,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  collapseActivity,
  expandActivity,
  getActivityState,
  getVisibleActivities,
  hasHiddenActivities,
  hideActivity,
  showHiddenActivities,
} from "./activity-state";
import { formatPullRequestActivityLocation } from "./activity-location";
import {
  buildPullRequestCommentContextAttachment,
  buildPullRequestCheckContextAttachment,
  buildPullRequestReviewContextAttachment,
  canAddPullRequestActivityToChat,
  canAddPullRequestCheckLogsToChat,
} from "./context-attachment";
import { getActivityVerb, getStateLabel } from "./data";
import type { CheckStatus, PrPaneActivity, PrPaneCheck, PrPaneData, PrState } from "./data";

function handleMarkdownLinkPress(url: string): boolean {
  void openExternalUrl(url);
  return false;
}

function rowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, Boolean(hovered) && styles.hoverable];
}

function activityPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.activityRow, Boolean(hovered) && styles.hoverable];
}

export function PullRequestPane({
  serverId,
  cwd,
  data,
  workspaceAttachmentScopeKey,
}: {
  serverId: string;
  cwd: string;
  data: PrPaneData;
  workspaceAttachmentScopeKey?: string;
}) {
  const { theme } = useUnistyles();
  const daemonClient = useHostRuntimeClient(serverId);
  const canFetchGitHubCheckDetails = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.githubCheckDetails === true,
  );
  const workspaceAttachments = useWorkspaceAttachments(workspaceAttachmentScopeKey ?? "");
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const [checksOpen, setChecksOpen] = useState(true);
  const [reviewsOpen, setReviewsOpen] = useState(true);
  const [activityState, setActivityState] = useState(getActivityState);

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
  const visibleActivities = useMemo(
    () => getVisibleActivities(activityState, { prNumber: data.number, activities: data.activity }),
    [activityState, data.activity, data.number],
  );
  const hasHidden = hasHiddenActivities(activityState, { prNumber: data.number });

  const handleAddActivityToChat = useCallback(
    (activity: PrPaneActivity) => {
      if (!workspaceAttachmentScopeKey) {
        return;
      }
      const input = {
        provider: data.provider,
        pullRequest: { number: data.number, title: data.title, url: data.url },
        activity,
      };
      const attachment =
        activity.kind === "comment"
          ? buildPullRequestCommentContextAttachment(input)
          : buildPullRequestReviewContextAttachment(input);
      if (!attachment) {
        return;
      }
      setWorkspaceAttachments({
        scopeKey: workspaceAttachmentScopeKey,
        attachments: appendWorkspaceAttachment(workspaceAttachments, attachment),
      });
    },
    [
      data.number,
      data.provider,
      data.title,
      data.url,
      setWorkspaceAttachments,
      workspaceAttachmentScopeKey,
      workspaceAttachments,
    ],
  );

  const handleAddCheckLogsToChat = useCallback(
    async (check: PrPaneCheck) => {
      if (!workspaceAttachmentScopeKey) {
        return;
      }
      let details = null;
      const ref = check.github;
      if (
        canFetchGitHubCheckDetails &&
        daemonClient &&
        check.provider === "github" &&
        ref?.checkRunId !== undefined &&
        data.repoOwner &&
        data.repoName
      ) {
        try {
          const payload = await daemonClient.checkoutGithubGetCheckDetails({
            cwd,
            repoOwner: data.repoOwner,
            repoName: data.repoName,
            checkRunId: ref.checkRunId,
            workflowRunId: ref.workflowRunId,
          });
          details = payload.success ? payload.details : null;
        } catch {
          details = null;
        }
      }
      const attachment = buildPullRequestCheckContextAttachment({
        provider: data.provider,
        pullRequest: { number: data.number, title: data.title, url: data.url },
        check,
        githubDetails: details,
      });
      setWorkspaceAttachments({
        scopeKey: workspaceAttachmentScopeKey,
        attachments: appendWorkspaceAttachment(workspaceAttachments, attachment),
      });
    },
    [
      canFetchGitHubCheckDetails,
      cwd,
      daemonClient,
      data.number,
      data.provider,
      data.repoName,
      data.repoOwner,
      data.title,
      data.url,
      setWorkspaceAttachments,
      workspaceAttachmentScopeKey,
      workspaceAttachments,
    ],
  );

  const handleToggleActivityCollapsed = useCallback(
    (activity: PrPaneActivity, collapsed: boolean) => {
      setActivityState((current) => {
        const identity = { prNumber: data.number, activityId: activity.id };
        return collapsed ? expandActivity(current, identity) : collapseActivity(current, identity);
      });
    },
    [data.number],
  );

  const handleHideActivity = useCallback(
    (activity: PrPaneActivity) => {
      setActivityState((current) =>
        hideActivity(current, { prNumber: data.number, activityId: activity.id }),
      );
    },
    [data.number],
  );

  const handleShowHidden = useCallback(() => {
    setActivityState((current) => showHiddenActivities(current, { prNumber: data.number }));
  }, [data.number]);

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
          <CheckRow key={check.name} check={check} onAddLogsToChat={handleAddCheckLogsToChat} />
        ))}
      </Section>

      <View style={styles.divider} />

      <Section
        title="Activity"
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
        {hasHidden ? (
          <View style={styles.showHiddenRow}>
            <Button variant="ghost" size="xs" onPress={handleShowHidden}>
              Show hidden
            </Button>
          </View>
        ) : null}
        {visibleActivities.map(({ activity, collapsed }) => (
          <ActivityCard
            key={`${activity.kind}-${activity.id}`}
            item={activity}
            collapsed={collapsed}
            onAddToChat={handleAddActivityToChat}
            onToggleCollapsed={handleToggleActivityCollapsed}
            onHide={handleHideActivity}
          />
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

function CheckRow({
  check,
  onAddLogsToChat,
}: {
  check: PrPaneCheck;
  onAddLogsToChat: (check: PrPaneCheck) => void;
}) {
  const handlePress = useCallback(() => {
    void openExternalUrl(check.url);
  }, [check.url]);
  const handleAddLogsToChat = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void onAddLogsToChat(check);
    },
    [check, onAddLogsToChat],
  );
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
      {canAddPullRequestCheckLogsToChat(check) ? (
        <Button variant="ghost" size="xs" onPress={handleAddLogsToChat}>
          Add logs to chat
        </Button>
      ) : null}
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

function ActivityCard({
  item,
  collapsed,
  onAddToChat,
  onToggleCollapsed,
  onHide,
}: {
  item: PrPaneActivity;
  collapsed: boolean;
  onAddToChat: (item: PrPaneActivity) => void;
  onToggleCollapsed: (item: PrPaneActivity, collapsed: boolean) => void;
  onHide: (item: PrPaneActivity) => void;
}) {
  const verb = getActivityVerb(item);
  const handleOpen = useCallback(() => {
    void openExternalUrl(item.url);
  }, [item.url]);
  const handleAddToChat = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onAddToChat(item);
    },
    [item, onAddToChat],
  );
  const handleCopy = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void writeMarkdownToRichClipboard(item.body, getDefaultMarkdownClipboardEnvironment());
    },
    [item.body],
  );
  const handleOpenPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(item.url);
    },
    [item.url],
  );
  const handleToggleCollapsed = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggleCollapsed(item, collapsed);
    },
    [collapsed, item, onToggleCollapsed],
  );
  const handleHide = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onHide(item);
    },
    [item, onHide],
  );
  const avatarStyle = useMemo(
    () => [styles.avatar, { backgroundColor: item.avatarColor }],
    [item.avatarColor],
  );
  const avatarSource = useMemo(
    () => (item.avatarUrl ? { uri: item.avatarUrl } : null),
    [item.avatarUrl],
  );
  const canAddToChat = canAddPullRequestActivityToChat(item);
  const locationLabel = formatPullRequestActivityLocation(item);
  return (
    <View style={styles.activityCard} testID="pr-pane-activity-row">
      <Pressable onPress={handleOpen} style={activityPressableStyle}>
        <View style={avatarStyle}>
          {avatarSource ? (
            <Image source={avatarSource} style={styles.avatarImage} />
          ) : (
            <Text style={styles.avatarText}>{item.author.slice(0, 1).toUpperCase()}</Text>
          )}
        </View>
        <View style={styles.activityMain}>
          <View style={styles.activityHeader}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.author}
            </Text>
            <Text style={styles.rowMetaMid}>{verb}</Text>
            <Text style={styles.rowMeta}>{item.age}</Text>
          </View>
          {locationLabel ? <Text style={styles.locationText}>{locationLabel}</Text> : null}
        </View>
      </Pressable>
      {collapsed ? null : (
        <View style={styles.markdownBody}>
          <SharedMarkdownRenderer
            text={item.body || "_No review body_"}
            compact
            onLinkPress={handleMarkdownLinkPress}
          />
        </View>
      )}
      <View style={styles.cardActions}>
        {canAddToChat ? (
          <Button variant="ghost" size="xs" onPress={handleAddToChat}>
            Add to chat
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" onPress={handleCopy} disabled={item.body.trim() === ""}>
          Copy
        </Button>
        <Button variant="ghost" size="xs" onPress={handleOpenPress}>
          Open on GitHub
        </Button>
        <Button variant="ghost" size="xs" onPress={handleToggleCollapsed}>
          {collapsed ? "Expand" : "Collapse"}
        </Button>
        <Button variant="ghost" size="xs" onPress={handleHide}>
          Hide
        </Button>
      </View>
    </View>
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
    flex: 1,
    minWidth: 0,
    padding: theme.spacing[3],
  },
  activityCard: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
    overflow: "hidden",
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
  locationText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
  },
  markdownBody: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  showHiddenRow: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
    overflow: "hidden",
  },
  avatarImage: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  avatarText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.normal,
    color: "#fff",
  },
}));
