import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  Copy,
  ExternalLink,
  EyeOff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
} from "lucide-react-native";
import type { PressableStateCallbackType } from "react-native";
import { openExternalUrl } from "@/utils/open-external-url";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  collapseActivity,
  expandActivity,
  getActivityState,
  getVisibleEntries,
  hasHiddenActivities,
  hideActivity,
  showHiddenActivities,
} from "./activity-state";
import { formatPullRequestThreadPath } from "./activity-location";
import {
  buildPullRequestCommentContextAttachment,
  buildPullRequestCheckContextAttachment,
  buildPullRequestReviewContextAttachment,
  canAddPullRequestActivityToChat,
  canAddPullRequestCheckLogsToChat,
} from "./context-attachment";
import { getActivityVerb, getStateLabel } from "./data";
import type { CheckStatus, PrPaneActivity, PrPaneCheck, PrPaneData, PrState } from "./data";
import { buildPrTimeline, type PrTimelineEntry } from "./timeline";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedCopy = withUnistyles(Copy);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedEyeOff = withUnistyles(EyeOff);
const ThemedGitMerge = withUnistyles(GitMerge);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedGitPullRequestClosed = withUnistyles(GitPullRequestClosed);
const ThemedGitPullRequestDraft = withUnistyles(GitPullRequestDraft);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedMessageSquarePlus = withUnistyles(MessageSquarePlus);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mergedColorMapping = (theme: Theme) => ({ color: theme.colors.statusMerged });

type IconColorMapping = typeof foregroundColorMapping;

interface PrStatePresentation {
  Icon: typeof ThemedGitPullRequest;
  iconColor: IconColorMapping;
}

const PR_STATE_PRESENTATION: Record<PrState, PrStatePresentation> = {
  open: { Icon: ThemedGitPullRequest, iconColor: successColorMapping },
  draft: { Icon: ThemedGitPullRequestDraft, iconColor: foregroundMutedColorMapping },
  merged: { Icon: ThemedGitMerge, iconColor: mergedColorMapping },
  closed: { Icon: ThemedGitPullRequestClosed, iconColor: dangerColorMapping },
};

const SUMMARY_SUCCESS_ICON = <ThemedCircleCheck size={12} uniProps={successColorMapping} />;
const SUMMARY_DANGER_ICON = <ThemedCircleX size={12} uniProps={dangerColorMapping} />;
const SUMMARY_WARNING_ICON = <ThemedCircleDot size={12} uniProps={warningColorMapping} />;
const SUMMARY_COMMENT_ICON = (
  <ThemedMessageSquare size={11} uniProps={foregroundMutedColorMapping} />
);
const ADD_TO_CHAT_MENU_ICON = (
  <ThemedMessageSquarePlus size={14} uniProps={foregroundMutedColorMapping} />
);
const COPY_MENU_ICON = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const OPEN_MENU_ICON = <ThemedExternalLink size={14} uniProps={foregroundMutedColorMapping} />;
const HIDE_MENU_ICON = <ThemedEyeOff size={14} uniProps={foregroundMutedColorMapping} />;

function handleMarkdownLinkPress(url: string): boolean {
  void openExternalUrl(url);
  return false;
}

function rowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.checkRow, Boolean(hovered) && styles.hoverable];
}

function entryHeaderPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.entryHeaderPressable, Boolean(hovered) && styles.hoverable];
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabButton, hovered && styles.kebabButtonHovered];
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreHorizontal
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function getCheckIdentity(check: PrPaneCheck): string {
  if (check.github?.checkRunId !== undefined) {
    return `${check.provider}:check-run:${check.github.checkRunId}`;
  }
  return `${check.provider}:${check.name}:${check.url}`;
}

function addLoadingCheck(current: ReadonlySet<string>, checkKey: string): ReadonlySet<string> {
  if (current.has(checkKey)) {
    return current;
  }
  const next = new Set(current);
  next.add(checkKey);
  return next;
}

function removeLoadingCheck(current: ReadonlySet<string>, checkKey: string): ReadonlySet<string> {
  if (!current.has(checkKey)) {
    return current;
  }
  const next = new Set(current);
  next.delete(checkKey);
  return next;
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
  const daemonClient = useHostRuntimeClient(serverId);
  const canFetchGitHubCheckDetails = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.githubCheckDetails === true,
  );
  const addWorkspaceAttachment = useWorkspaceAttachmentsStore(
    (state) => state.addWorkspaceAttachment,
  );
  const [checksOpen, setChecksOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(true);
  const [activityState, setActivityState] = useState(getActivityState);
  const [loadingCheckKeys, setLoadingCheckKeys] = useState<ReadonlySet<string>>(() => new Set());

  const handleOpenPrUrl = useCallback(() => {
    void openExternalUrl(data.url);
  }, [data.url]);

  const handleToggleChecks = useCallback(() => {
    setChecksOpen((open) => !open);
  }, []);

  const handleToggleActivity = useCallback(() => {
    setActivityOpen((open) => !open);
  }, []);

  const passed = data.checks.filter((check) => check.status === "success").length;
  const failed = data.checks.filter((check) => check.status === "failure").length;
  const pending = data.checks.filter((check) => check.status === "pending").length;

  const approvals = data.activity.filter(
    (item) => item.kind === "review" && item.reviewState === "approved",
  ).length;
  const changesRequested = data.activity.filter(
    (item) => item.kind === "review" && item.reviewState === "changes_requested",
  ).length;
  const commentCount = data.activity.filter(
    (item) =>
      item.kind === "comment" || (item.kind === "review" && item.reviewState === "commented"),
  ).length;

  const visibleEntries = useMemo(
    () =>
      getVisibleEntries(activityState, {
        prNumber: data.number,
        entries: buildPrTimeline(data.activity),
      }),
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
      addWorkspaceAttachment({
        scopeKey: workspaceAttachmentScopeKey,
        attachment,
      });
    },
    [
      addWorkspaceAttachment,
      data.number,
      data.provider,
      data.title,
      data.url,
      workspaceAttachmentScopeKey,
    ],
  );

  const handleAddCheckLogsToChat = useCallback(
    async (check: PrPaneCheck) => {
      if (!workspaceAttachmentScopeKey) {
        return;
      }
      const checkKey = getCheckIdentity(check);
      setLoadingCheckKeys((current) => addLoadingCheck(current, checkKey));

      let details = null;
      try {
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
        addWorkspaceAttachment({
          scopeKey: workspaceAttachmentScopeKey,
          attachment,
        });
      } catch {
        // The check row should recover even if attachment formatting or insertion fails.
      } finally {
        setLoadingCheckKeys((current) => removeLoadingCheck(current, checkKey));
      }
    },
    [
      addWorkspaceAttachment,
      canFetchGitHubCheckDetails,
      cwd,
      daemonClient,
      data.number,
      data.provider,
      data.repoName,
      data.repoOwner,
      data.title,
      data.url,
      workspaceAttachmentScopeKey,
    ],
  );

  const handleToggleEntryCollapsed = useCallback(
    (entryId: string, collapsed: boolean) => {
      setActivityState((current) => {
        const identity = { prNumber: data.number, activityId: entryId };
        return collapsed ? expandActivity(current, identity) : collapseActivity(current, identity);
      });
    },
    [data.number],
  );

  const handleHideEntry = useCallback(
    (entryId: string) => {
      setActivityState((current) =>
        hideActivity(current, { prNumber: data.number, activityId: entryId }),
      );
    },
    [data.number],
  );

  const handleShowHidden = useCallback(() => {
    setActivityState((current) => showHiddenActivities(current, { prNumber: data.number }));
  }, [data.number]);

  const statePresentation = PR_STATE_PRESENTATION[data.state];
  const StateIcon = statePresentation.Icon;

  return (
    <View style={styles.root} testID="pr-pane">
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <Pressable onPress={handleOpenPrUrl} style={styles.header}>
          {({ hovered }) => (
            <>
              <Text style={styles.title} testID="pr-pane-title">
                {data.title}
                <Text style={styles.titleNumber}> #{data.number}</Text>
              </Text>
              <View style={styles.metaLine}>
                <StateIcon size={14} uniProps={statePresentation.iconColor} />
                <Text style={stateLabelStyle(data.state)} testID="pr-pane-state">
                  {getStateLabel(data.state)}
                </Text>
                {data.repoOwner && data.repoName ? (
                  <Text style={styles.repoRef} numberOfLines={1}>
                    {data.repoOwner}/{data.repoName}
                  </Text>
                ) : null}
                <View style={hovered ? styles.headerLinkIcon : styles.headerLinkIconHidden}>
                  <ThemedExternalLink size={12} uniProps={foregroundMutedColorMapping} />
                </View>
              </View>
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
                icon={SUMMARY_SUCCESS_ICON}
                variant="success"
                testID="pr-pane-check-passed"
              />
              <SummaryPill
                count={failed}
                icon={SUMMARY_DANGER_ICON}
                variant="danger"
                testID="pr-pane-check-failed"
              />
              <SummaryPill
                count={pending}
                icon={SUMMARY_WARNING_ICON}
                variant="warning"
                testID="pr-pane-check-pending"
              />
            </>
          }
        >
          {data.checks.length === 0 ? (
            <Text style={styles.emptyText}>No checks</Text>
          ) : (
            data.checks.map((check) => {
              const checkKey = getCheckIdentity(check);
              return (
                <CheckRow
                  key={checkKey}
                  check={check}
                  isAddingLogsToChat={loadingCheckKeys.has(checkKey)}
                  onAddLogsToChat={handleAddCheckLogsToChat}
                />
              );
            })
          )}
        </Section>

        <View style={styles.divider} />

        <Section
          title="Activity"
          open={activityOpen}
          onToggle={handleToggleActivity}
          summary={
            <>
              <SummaryPill count={approvals} icon={SUMMARY_SUCCESS_ICON} variant="success" />
              <SummaryPill count={changesRequested} icon={SUMMARY_DANGER_ICON} variant="danger" />
              <SummaryPill count={commentCount} icon={SUMMARY_COMMENT_ICON} variant="muted" />
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
          {visibleEntries.length === 0 && !hasHidden ? (
            <Text style={styles.emptyText}>No activity yet</Text>
          ) : (
            visibleEntries.map(({ entry, collapsed }) => (
              <TimelineEntryCard
                key={entry.id}
                entry={entry}
                collapsed={collapsed}
                onAddToChat={handleAddActivityToChat}
                onToggleCollapsed={handleToggleEntryCollapsed}
                onHide={handleHideEntry}
              />
            ))
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

function stateLabelStyle(state: PrState) {
  if (state === "open") return styles.stateLabelOpen;
  if (state === "draft") return styles.stateLabelDraft;
  if (state === "merged") return styles.stateLabelMerged;
  return styles.stateLabelClosed;
}

interface SectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, open, onToggle, summary, children }: SectionProps) {
  return (
    <View>
      <Pressable style={styles.sectionHeader} onPress={onToggle}>
        {open ? (
          <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
        )}
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.summaryWrap}>{summary}</View>
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

function SummaryPill({
  count,
  icon,
  variant,
  testID,
}: {
  count: number;
  icon: React.ReactNode;
  variant: "success" | "danger" | "warning" | "muted";
  testID?: string;
}) {
  if (count === 0) return null;
  return (
    <View style={styles.summaryPill} testID={testID}>
      {icon}
      <Text style={summaryPillTextStyle(variant)}>{count}</Text>
    </View>
  );
}

function summaryPillTextStyle(variant: "success" | "danger" | "warning" | "muted") {
  if (variant === "success") return styles.summaryPillSuccessText;
  if (variant === "danger") return styles.summaryPillDangerText;
  if (variant === "warning") return styles.summaryPillWarningText;
  return styles.summaryPillMutedText;
}

function CheckRow({
  check,
  isAddingLogsToChat,
  onAddLogsToChat,
}: {
  check: PrPaneCheck;
  isAddingLogsToChat: boolean;
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
      <Text style={styles.checkName} numberOfLines={1}>
        {check.name}
      </Text>
      {check.workflow && (
        <Text style={styles.checkWorkflow} numberOfLines={1}>
          {check.workflow}
        </Text>
      )}
      <View style={styles.checkTrailing}>
        {check.duration && <Text style={styles.checkDuration}>{check.duration}</Text>}
        {canAddPullRequestCheckLogsToChat(check) ? (
          <Button
            variant="ghost"
            size="xs"
            loading={isAddingLogsToChat}
            onPress={handleAddLogsToChat}
          >
            {isAddingLogsToChat ? "Adding logs" : "Add logs to chat"}
          </Button>
        ) : null}
      </View>
    </Pressable>
  );
}

function CheckStatusIcon({ status }: { status: CheckStatus }) {
  if (status === "success") return <ThemedCircleCheck size={14} uniProps={successColorMapping} />;
  if (status === "failure") return <ThemedCircleX size={14} uniProps={dangerColorMapping} />;
  if (status === "pending") return <ThemedCircleDot size={14} uniProps={warningColorMapping} />;
  return <ThemedCircleSlash size={14} uniProps={foregroundMutedColorMapping} />;
}

interface TimelineEntryCallbacks {
  onAddToChat: (activity: PrPaneActivity) => void;
  onToggleCollapsed: (entryId: string, collapsed: boolean) => void;
  onHide: (entryId: string) => void;
}

function TimelineEntryCard({
  entry,
  collapsed,
  onAddToChat,
  onToggleCollapsed,
  onHide,
}: TimelineEntryCallbacks & {
  entry: PrTimelineEntry;
  collapsed: boolean;
}) {
  if (entry.kind === "thread") {
    return (
      <ThreadCard
        entry={entry}
        collapsed={collapsed}
        onAddToChat={onAddToChat}
        onToggleCollapsed={onToggleCollapsed}
        onHide={onHide}
      />
    );
  }
  return (
    <SingleActivityCard
      entry={entry}
      collapsed={collapsed}
      onAddToChat={onAddToChat}
      onToggleCollapsed={onToggleCollapsed}
      onHide={onHide}
    />
  );
}

function useRevealOnHover() {
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const actionsVisible = isHovered || menuOpen || isNative || isCompact;
  return { actionsVisible, handlePointerEnter, handlePointerLeave, setMenuOpen };
}

function ActivityKebab({
  activity,
  visible,
  onMenuOpenChange,
  onAddToChat,
  onHide,
}: {
  activity: PrPaneActivity;
  visible: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onAddToChat: (activity: PrPaneActivity) => void;
  onHide?: () => void;
}) {
  const handleAddToChat = useCallback(() => onAddToChat(activity), [activity, onAddToChat]);
  const handleCopy = useCallback(() => {
    void writeMarkdownToRichClipboard(activity.body, getDefaultMarkdownClipboardEnvironment());
  }, [activity.body]);
  const handleOpen = useCallback(() => {
    void openExternalUrl(activity.url);
  }, [activity.url]);

  return (
    <View style={kebabSlotStyle(visible)} pointerEvents={visible ? "auto" : "none"}>
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger
          hitSlop={8}
          style={kebabTriggerStyle}
          accessibilityLabel="Comment actions"
        >
          {renderKebabTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={200}>
          {canAddPullRequestActivityToChat(activity) ? (
            <DropdownMenuItem leading={ADD_TO_CHAT_MENU_ICON} onSelect={handleAddToChat}>
              Add to chat
            </DropdownMenuItem>
          ) : null}
          {activity.body.trim() !== "" ? (
            <DropdownMenuItem leading={COPY_MENU_ICON} onSelect={handleCopy}>
              Copy
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem leading={OPEN_MENU_ICON} onSelect={handleOpen}>
            Open on GitHub
          </DropdownMenuItem>
          {onHide ? (
            <DropdownMenuItem leading={HIDE_MENU_ICON} onSelect={onHide}>
              Hide
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function kebabSlotStyle(visible: boolean) {
  return visible ? styles.kebabSlot : styles.kebabSlotHidden;
}

function ActivityAvatar({ activity, size }: { activity: PrPaneActivity; size: number }) {
  const frameStyle = useMemo(
    () => [
      styles.avatar,
      {
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: activity.avatarColor,
      },
    ],
    [activity.avatarColor, size],
  );
  const imageStyle = useMemo(() => ({ width: size, height: size, borderRadius: size / 2 }), [size]);
  const imageSource = useMemo(
    () => (activity.avatarUrl ? { uri: activity.avatarUrl } : null),
    [activity.avatarUrl],
  );
  return (
    <View style={frameStyle}>
      {imageSource ? (
        <Image source={imageSource} style={imageStyle} />
      ) : (
        <Text style={styles.avatarText}>{activity.author.slice(0, 1).toUpperCase()}</Text>
      )}
    </View>
  );
}

function ActivityVerb({ activity }: { activity: PrPaneActivity }) {
  const verb = getActivityVerb(activity).toLowerCase();
  if (activity.kind === "review" && activity.reviewState === "approved") {
    return (
      <View style={styles.verbGroup}>
        <ThemedCircleCheck size={12} uniProps={successColorMapping} />
        <Text style={styles.verbSuccess}>{verb}</Text>
      </View>
    );
  }
  if (activity.kind === "review" && activity.reviewState === "changes_requested") {
    return (
      <View style={styles.verbGroup}>
        <ThemedCircleX size={12} uniProps={dangerColorMapping} />
        <Text style={styles.verbDanger}>{verb}</Text>
      </View>
    );
  }
  return <Text style={styles.verbMuted}>{verb}</Text>;
}

function ActivityHeader({
  activity,
  avatarSize,
  children,
}: {
  activity: PrPaneActivity;
  avatarSize: number;
  children?: React.ReactNode;
}) {
  return (
    <>
      <ActivityAvatar activity={activity} size={avatarSize} />
      <Text style={styles.authorText} numberOfLines={1}>
        {activity.author}
      </Text>
      <ActivityVerb activity={activity} />
      <View style={styles.headerTrailing}>
        <Text style={styles.ageText}>{activity.age}</Text>
        {children}
      </View>
    </>
  );
}

function SingleActivityCard({
  entry,
  collapsed,
  onAddToChat,
  onToggleCollapsed,
  onHide,
}: TimelineEntryCallbacks & {
  entry: Extract<PrTimelineEntry, { kind: "single" }>;
  collapsed: boolean;
}) {
  const { activity } = entry;
  const { actionsVisible, handlePointerEnter, handlePointerLeave, setMenuOpen } =
    useRevealOnHover();
  const hasBody = activity.body.trim() !== "";
  const handleHide = useCallback(() => onHide(entry.id), [entry.id, onHide]);
  const handleHeaderPress = useCallback(() => {
    if (hasBody) {
      onToggleCollapsed(entry.id, collapsed);
      return;
    }
    void openExternalUrl(activity.url);
  }, [activity.url, collapsed, entry.id, hasBody, onToggleCollapsed]);

  if (!hasBody) {
    return (
      <View
        style={styles.eventRow}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        testID="pr-pane-activity-row"
      >
        <Pressable onPress={handleHeaderPress} style={entryHeaderPressableStyle}>
          <ActivityHeader activity={activity} avatarSize={20}>
            <ActivityKebab
              activity={activity}
              visible={actionsVisible}
              onMenuOpenChange={setMenuOpen}
              onAddToChat={onAddToChat}
              onHide={handleHide}
            />
          </ActivityHeader>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={styles.card}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="pr-pane-activity-row"
    >
      <Pressable onPress={handleHeaderPress} style={entryHeaderPressableStyle}>
        <ActivityHeader activity={activity} avatarSize={20}>
          <ActivityKebab
            activity={activity}
            visible={actionsVisible}
            onMenuOpenChange={setMenuOpen}
            onAddToChat={onAddToChat}
            onHide={handleHide}
          />
        </ActivityHeader>
      </Pressable>
      {collapsed ? null : (
        <View style={styles.cardBody}>
          <MarkdownRenderer text={activity.body} compact onLinkPress={handleMarkdownLinkPress} />
        </View>
      )}
    </View>
  );
}

function ThreadCard({
  entry,
  collapsed,
  onAddToChat,
  onToggleCollapsed,
  onHide,
}: TimelineEntryCallbacks & {
  entry: Extract<PrTimelineEntry, { kind: "thread" }>;
  collapsed: boolean;
}) {
  const { actionsVisible, handlePointerEnter, handlePointerLeave, setMenuOpen } =
    useRevealOnHover();
  const handleHeaderPress = useCallback(() => {
    onToggleCollapsed(entry.id, collapsed);
  }, [collapsed, entry.id, onToggleCollapsed]);
  const handleHide = useCallback(() => onHide(entry.id), [entry.id, onHide]);
  const handleOpenThread = useCallback(() => {
    void openExternalUrl(entry.comments[0].url);
  }, [entry.comments]);

  const [root, ...replies] = entry.comments;

  return (
    <View
      style={styles.card}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="pr-pane-activity-row"
    >
      <Pressable onPress={handleHeaderPress} style={threadHeaderPressableStyle}>
        <Text style={styles.threadPath} numberOfLines={1}>
          {formatPullRequestThreadPath(entry.location)}
        </Text>
        {entry.location.isResolved ? <StatusBadge label="Resolved" variant="success" /> : null}
        {entry.location.isOutdated ? <StatusBadge label="Outdated" /> : null}
        <View style={styles.headerTrailing}>
          {collapsed ? (
            <View style={styles.threadCount}>
              <ThemedMessageSquare size={11} uniProps={foregroundMutedColorMapping} />
              <Text style={styles.ageText}>{entry.comments.length}</Text>
            </View>
          ) : null}
          <View
            style={kebabSlotStyle(actionsVisible)}
            pointerEvents={actionsVisible ? "auto" : "none"}
          >
            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger
                hitSlop={8}
                style={kebabTriggerStyle}
                accessibilityLabel="Thread actions"
              >
                {renderKebabTriggerIcon}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={200}>
                <DropdownMenuItem leading={OPEN_MENU_ICON} onSelect={handleOpenThread}>
                  Open on GitHub
                </DropdownMenuItem>
                <DropdownMenuItem leading={HIDE_MENU_ICON} onSelect={handleHide}>
                  Hide
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        </View>
      </Pressable>
      {collapsed ? null : (
        <>
          <ThreadComment comment={root} onAddToChat={onAddToChat} />
          {replies.length > 0 ? (
            <View style={styles.replyRail}>
              {replies.map((reply) => (
                <ThreadComment key={reply.id} comment={reply} onAddToChat={onAddToChat} />
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function threadHeaderPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.threadHeader, Boolean(hovered) && styles.hoverable];
}

function ThreadComment({
  comment,
  onAddToChat,
}: {
  comment: PrPaneActivity;
  onAddToChat: (activity: PrPaneActivity) => void;
}) {
  const { actionsVisible, handlePointerEnter, handlePointerLeave, setMenuOpen } =
    useRevealOnHover();
  return (
    <View
      style={styles.threadComment}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <View style={styles.threadCommentHeader}>
        <ActivityHeader activity={comment} avatarSize={16}>
          <ActivityKebab
            activity={comment}
            visible={actionsVisible}
            onMenuOpenChange={setMenuOpen}
            onAddToChat={onAddToChat}
          />
        </ActivityHeader>
      </View>
      {comment.body.trim() !== "" ? (
        <View style={styles.threadCommentBody}>
          <MarkdownRenderer text={comment.body} compact onLinkPress={handleMarkdownLinkPress} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  invisible: {
    opacity: 0,
  },
  hoverable: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  header: {
    flexDirection: "column",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    lineHeight: 22,
  },
  titleNumber: {
    color: theme.colors.foregroundMuted,
  },
  metaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 16,
  },
  stateLabelOpen: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  stateLabelDraft: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  stateLabelMerged: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusMerged,
  },
  stateLabelClosed: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
  repoRef: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    marginLeft: theme.spacing[1],
  },
  headerLinkIcon: {
    marginLeft: theme.spacing[1],
  },
  headerLinkIconHidden: {
    marginLeft: theme.spacing[1],
    opacity: 0,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  sectionBody: {
    paddingBottom: theme.spacing[3],
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
  summaryPillSuccessText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusSuccess,
  },
  summaryPillDangerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusDanger,
  },
  summaryPillWarningText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.statusWarning,
  },
  summaryPillMutedText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 32,
  },
  checkName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  checkWorkflow: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  checkTrailing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  checkDuration: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  showHiddenRow: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  eventRow: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  card: {
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
    overflow: "hidden",
  },
  entryHeaderPressable: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
  },
  headerTrailing: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  authorText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  verbGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  verbMuted: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  verbSuccess: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusSuccess,
  },
  verbDanger: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  ageText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  kebabSlot: {
    width: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  kebabSlotHidden: {
    width: 22,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0,
  },
  kebabButton: {
    padding: 2,
    borderRadius: 4,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cardBody: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  threadHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minHeight: 36,
    backgroundColor: theme.colors.surface1,
  },
  threadPath: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  threadCount: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  threadComment: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingBottom: theme.spacing[2],
  },
  threadCommentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    minHeight: 32,
  },
  threadCommentBody: {
    paddingHorizontal: theme.spacing[3],
  },
  replyRail: {
    marginLeft: theme.spacing[4],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.normal,
    color: "#fff",
  },
}));
