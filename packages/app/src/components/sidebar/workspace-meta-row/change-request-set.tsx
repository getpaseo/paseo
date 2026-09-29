import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronRight,
  GitPullRequest,
  Plus,
  ScanSearch,
  X,
} from "@/components/icons/ui-icons";
import { openExternalUrl } from "@/utils/open-external-url";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import {
  relatedPullRequestsHealthCount,
  type RelatedPullRequest,
  type RelatedPullRequestsHealth,
  type RelatedPullRequestsSummary,
} from "@/git/related-pull-requests";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedPlus = withUnistyles(Plus);
const ThemedScanSearch = withUnistyles(ScanSearch);
const ThemedX = withUnistyles(X);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const PR_ICON_SIZE = 16;

/**
 * The collapsed stand-in for a workspace's change requests: with several, how many there are
 * and the worst thing happening across them; with one, that change request's own number. It
 * replaces the single change request and its CI on the line, because a row that reports the
 * checked-out layer's `passed` beside a red sibling reads as finished.
 *
 * The health word carries its own count — one red change request and six red ones are different
 * mornings, and this line is what decides which one gets opened first.
 *
 * Pressing it toggles the list rather than opening a link — the number is a count, not a
 * destination, and there is no single change request it could sensibly navigate to.
 */
export function ChangeRequestSetItem({
  summary,
  soleNumber,
  expanded,
  onToggle,
}: {
  summary: RelatedPullRequestsSummary;
  /** Set when the set holds exactly one change request: the line names it instead of counting. */
  soleNumber: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();

  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onToggle();
    },
    [onToggle],
  );

  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  // Everything merged is the finished state, and the line should read as done at a glance.
  const allMerged = summary.total > 0 && summary.mergedCount === summary.total;
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={toggleAccessibilityLabel(t, summary.total, soleNumber)}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      style={pressableStyle}
      testID="workspace-change-request-set"
    >
      <Chevron size={12} uniProps={mutedMapping} />
      {allMerged ? (
        <PullRequestStateIcon state="merged" size={PR_ICON_SIZE} />
      ) : (
        <ThemedGitPullRequest size={PR_ICON_SIZE} uniProps={mutedMapping} />
      )}
      {summary.total === 0 ? null : (
        <Text style={styles.countText} numberOfLines={1}>
          {soleNumber === null
            ? t("workspace.git.pr.set.count", { count: summary.total })
            : soleNumber}
        </Text>
      )}
      {allMerged ? (
        <>
          <Text style={styles.separator}>·</Text>
          <Text style={styles.mergedText} numberOfLines={1}>
            {t("workspace.git.pr.states.merged")}
          </Text>
        </>
      ) : null}
      {summary.health === "unknown" ? null : (
        <>
          <Text style={styles.separator}>·</Text>
          <Text style={healthTextStyle(summary.health)} numberOfLines={1}>
            {t(HEALTH_LABEL_KEYS[summary.health], {
              count: relatedPullRequestsHealthCount(summary),
            })}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/**
 * What the control announces: the one number it names, how many it stands for, or — with none
 * yet — that this is where they get attached. Extracted so the item stays one expression.
 */
function toggleAccessibilityLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  total: number,
  soleNumber: number | null,
): string {
  if (soleNumber !== null) {
    return t("workspace.git.pr.set.toggleOneAccessibility", { number: soleNumber });
  }
  if (total === 0) {
    return t("workspace.git.pr.set.toggleEmptyAccessibility");
  }
  return t("workspace.git.pr.set.toggleAccessibility", { count: total });
}

const HEALTH_LABEL_KEYS = {
  failing: "workspace.git.pr.set.failing",
  running: "workspace.git.pr.set.running",
  passing: "workspace.git.pr.set.passing",
} as const;

const CHECK_LABEL_KEYS = {
  failure: "workspace.git.pr.checksSummary.failedLabel",
  pending: "workspace.git.pr.checksSummary.runningLabel",
  success: "workspace.git.pr.checksSummary.passedLabel",
} as const;

/**
 * The expanded set: one change request per line, in the order the daemon resolved, inside a
 * panel of its own. Its header is the count and nothing else — a word naming what a list of
 * pull requests is costs a line of sidebar to say what the glyph above already said. It is
 * where the set is read *and* kept — adding and dropping entries belong
 * next to the list they change, not in a kebab menu two clicks away from what it edits.
 *
 * Each line carries its own check state and its own additions and deletions. They come from the
 * same forge call that resolved the set, and they are the figures that belong to a change
 * request — unlike the workspace diff stat on the row above, which measures the worktree.
 */
export function ChangeRequestSetList({
  pullRequests,
  onRemovePullRequest,
  onAttachPullRequest,
  onScanChat,
  scanning = false,
}: {
  pullRequests: readonly RelatedPullRequest[];
  /**
   * Drop a line from this workspace's set. Absent where there is nothing to
   * curate against (previews).
   */
  onRemovePullRequest?: (number: number) => void;
  /** Opens the attach prompt. Absent where the row has no host to ask. */
  onAttachPullRequest?: () => void;
  /** Re-reads the workspace's agent transcripts for change request references. */
  onScanChat?: () => void;
  scanning?: boolean;
}) {
  const { t } = useTranslation();
  const manageable = onAttachPullRequest !== undefined || onScanChat !== undefined;

  return (
    <View style={styles.panel} testID="workspace-change-request-set-list">
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle} numberOfLines={1}>
          {t("workspace.git.pr.set.count", { count: pullRequests.length })}
        </Text>
        {manageable ? (
          <View style={styles.panelActions}>
            {onAttachPullRequest ? (
              <PanelAction
                icon="add"
                label={t("workspace.git.pr.set.addAction")}
                onPress={onAttachPullRequest}
                testID="workspace-change-request-set-add"
              />
            ) : null}
            {onScanChat ? (
              <PanelAction
                icon="scan"
                label={t("workspace.git.pr.set.scanAction")}
                onPress={onScanChat}
                pending={scanning}
                testID="workspace-change-request-set-scan"
              />
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={styles.list}>
        {pullRequests.length === 0 ? (
          <Text style={styles.emptyText}>{t("workspace.git.pr.set.emptyList")}</Text>
        ) : (
          pullRequests.map((pullRequest) => (
            <ChangeRequestSetRow
              key={pullRequest.number}
              pullRequest={pullRequest}
              onRemove={onRemovePullRequest}
            />
          ))
        )}
      </View>
    </View>
  );
}

function PanelAction({
  icon,
  label,
  onPress,
  pending = false,
  testID,
}: {
  icon: "add" | "scan";
  label: string;
  onPress: () => void;
  pending?: boolean;
  testID: string;
}) {
  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  const Icon = icon === "add" ? ThemedPlus : ThemedScanSearch;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={pendingState(pending)}
      disabled={pending}
      hitSlop={6}
      onPressIn={handlePressIn}
      onPress={handlePress}
      style={panelActionStyle}
      testID={testID}
    >
      <Icon size={11} uniProps={mutedMapping} />
      <Text style={styles.panelActionText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function pendingState(pending: boolean) {
  return { busy: pending, disabled: pending };
}

function ChangeRequestSetRow({
  pullRequest,
  onRemove,
}: {
  pullRequest: RelatedPullRequest;
  onRemove?: (number: number) => void;
}) {
  const { t } = useTranslation();

  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(pullRequest.url);
    },
    [pullRequest.url],
  );
  const handleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onRemove?.(pullRequest.number);
    },
    [onRemove, pullRequest.number],
  );
  const handleRemovePressIn = useCallback(
    (event: GestureResponderEvent) => event.stopPropagation(),
    [],
  );
  const handleRemovePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onRemove?.(pullRequest.number);
    },
    [onRemove, pullRequest.number],
  );

  const hasDiff = pullRequest.additions !== undefined || pullRequest.deletions !== undefined;
  const checkKey = checkLabelKey(pullRequest.checksStatus);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: pullRequest.number,
      })}
      accessibilityHint={
        onRemove
          ? t("workspace.git.pr.set.removePullRequest", { number: pullRequest.number })
          : undefined
      }
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onLongPress={onRemove ? handleLongPress : undefined}
      style={listRowStyle}
      testID={`workspace-change-request-${pullRequest.number}`}
    >
      <PullRequestStateIcon state={pullRequest.state} size={PR_ICON_SIZE} />
      <Text
        style={pullRequest.origin === "current" ? styles.numberTextCurrent : styles.numberText}
        numberOfLines={1}
      >
        {pullRequest.number}
      </Text>
      {pullRequest.title ? (
        <Text style={styles.titleText} numberOfLines={1}>
          {pullRequest.title}
        </Text>
      ) : (
        <View style={styles.titleSpacer} />
      )}
      {pullRequest.isDraft ? (
        <Text style={styles.draftText} numberOfLines={1}>
          {t("workspace.git.pr.set.draft")}
        </Text>
      ) : null}
      {hasDiff ? (
        <View style={styles.diff}>
          <Text style={styles.additions}>{`+${pullRequest.additions ?? 0}`}</Text>
          <Text style={styles.deletions}>{`-${pullRequest.deletions ?? 0}`}</Text>
        </View>
      ) : null}
      {checkKey ? (
        <Text style={checkTextStyle(pullRequest.checksStatus)} numberOfLines={1}>
          {t(checkKey)}
        </Text>
      ) : null}
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("workspace.git.pr.set.removePullRequest", {
            number: pullRequest.number,
          })}
          hitSlop={6}
          onPressIn={handleRemovePressIn}
          onPress={handleRemovePress}
          style={removeButtonStyle}
          testID={`workspace-change-request-remove-${pullRequest.number}`}
        >
          <ThemedX size={11} uniProps={mutedMapping} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function checkLabelKey(
  status: RelatedPullRequest["checksStatus"],
): (typeof CHECK_LABEL_KEYS)[keyof typeof CHECK_LABEL_KEYS] | null {
  if (status === "failure" || status === "pending" || status === "success") {
    return CHECK_LABEL_KEYS[status];
  }
  return null;
}

function pressableStyle({ pressed }: { pressed: boolean }) {
  return [styles.item, pressed && styles.itemPressed];
}

function listRowStyle({ pressed }: { pressed: boolean }) {
  return [styles.listRow, pressed && styles.listRowPressed];
}

function panelActionStyle({ pressed }: { pressed: boolean }) {
  return [styles.panelAction, pressed && styles.itemPressed];
}

function removeButtonStyle({ pressed }: { pressed: boolean }) {
  return [styles.removeButton, pressed && styles.itemPressed];
}

const styles = StyleSheet.create((theme) => ({
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flexShrink: 0,
  },
  itemPressed: {
    opacity: 0.82,
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  countText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  /**
   * The list gets a panel rather than four more lines of sidebar text: it is a second subject
   * under the row's own, and it is edited in place. The outline is what tells a reader where
   * the workspace's line ends and its set begins, and the padding is what makes a list of eight
   * readable instead of dense.
   */
  panel: {
    marginTop: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    gap: theme.spacing[1],
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  panelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    fontWeight: "600",
    flexShrink: 1,
  },
  panelActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
    flexShrink: 0,
  },
  panelAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[0.5],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  panelActionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
  },
  list: {
    gap: theme.spacing[0.5],
  },
  emptyText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    paddingVertical: theme.spacing[0.5],
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    minHeight: 24,
    paddingVertical: theme.spacing[0.5],
    paddingHorizontal: theme.spacing[0.5],
    borderRadius: theme.borderRadius.base,
  },
  listRowPressed: {
    opacity: 0.82,
    backgroundColor: theme.colors.surface2,
  },
  mergedText: {
    color: theme.colors.statusMerged,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  numberText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
  numberTextCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
    fontWeight: "600",
  },
  titleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexGrow: 1,
    flexShrink: 1,
  },
  // Keeps the trailing state on the right edge when a change request has no title yet.
  titleSpacer: {
    flexGrow: 1,
    flexShrink: 1,
  },
  draftText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
  diff: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  additions: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  deletions: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  removeButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.base,
    flexShrink: 0,
  },
  healthPassing: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  healthFailing: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  healthRunning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
  checkPassing: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
  checkFailing: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
  checkRunning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flexShrink: 0,
  },
}));

// Read inside render, never into a module-scope table — see docs/unistyles.md.
function healthTextStyle(health: Exclude<RelatedPullRequestsHealth, "unknown">) {
  if (health === "failing") return styles.healthFailing;
  if (health === "running") return styles.healthRunning;
  return styles.healthPassing;
}

function checkTextStyle(status: RelatedPullRequest["checksStatus"]) {
  if (status === "failure") return styles.checkFailing;
  if (status === "pending") return styles.checkRunning;
  return styles.checkPassing;
}
