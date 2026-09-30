import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildSchedulesRoute } from "@/utils/host-routes";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  availableSnoozeOptions,
  snoozeUntil,
  type InboxItem,
  type InboxKind,
  type ScheduleErrorInboxItem,
  type SessionInboxItem,
  type SnoozeOption,
} from "./inbox-model";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { LeitstandPanda } from "./leitstand-panda";
import { MarkDoneButton } from "./mark-done-button";
import { InboxReplyInput, InboxReplyPreview } from "./inbox-reply";
import { StatusGlyph, glyphForInboxKind } from "./status-glyph";
import { AgeText, ProjectTag } from "./tags";
import type { SnoozableInbox } from "./use-leitstand";
import { MONO_FONT_DATASET } from "@/styles/font-dataset";

type TFunction = ReturnType<typeof useTranslation>["t"];
type ButtonSize = "sm" | "md";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const KIND_LABEL_KEY = {
  permission: "leitstand.inbox.kinds.permission",
  question: "leitstand.inbox.kinds.question",
  agent_error: "leitstand.inbox.kinds.agentError",
  schedule_error: "leitstand.inbox.kinds.scheduleError",
  checks_failed: "leitstand.inbox.kinds.checksFailed",
  merge_ready: "leitstand.inbox.kinds.mergeReady",
  finished: "leitstand.inbox.kinds.finished",
} as const satisfies Record<InboxKind, string>;

const SNOOZE_LABEL_KEY = {
  hour: "leitstand.inbox.actions.snoozeHour",
  evening: "leitstand.inbox.actions.snoozeEvening",
  morning: "leitstand.inbox.actions.snoozeMorning",
} as const satisfies Record<SnoozeOption, string>;

function describeReason(item: InboxItem, t: TFunction): string {
  switch (item.kind) {
    case "permission":
      return t("leitstand.inbox.reasons.permission", {
        agent: item.agentLabel,
        request: item.request,
      });
    case "question":
      return t("leitstand.inbox.reasons.question");
    case "agent_error":
      return item.error
        ? t("leitstand.inbox.reasons.agentError", { error: item.error })
        : t("leitstand.inbox.reasons.agentErrorUnknown");
    case "schedule_error":
      return item.error
        ? t("leitstand.inbox.reasons.scheduleError", { error: item.error })
        : t("leitstand.inbox.reasons.scheduleErrorUnknown");
    case "checks_failed":
      return t("leitstand.inbox.reasons.checksFailed", {
        count: item.failingCount,
        number: item.pullRequest.number,
      });
    case "merge_ready":
      return t("leitstand.inbox.reasons.mergeReady", { number: item.pullRequest.number });
    case "finished":
      return t("leitstand.inbox.reasons.finished");
  }
}

export function InboxSection({ inbox }: { inbox: SnoozableInbox }) {
  const { t } = useTranslation();
  const count = inbox.items.length;
  return (
    <View style={styles.inbox} testID="leitstand-inbox">
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {t("leitstand.inbox.title")}
        </Text>
        <Text dataSet={MONO_FONT_DATASET} style={styles.count} testID="leitstand-inbox-count">
          {count}
        </Text>
        {inbox.snoozedCount > 0 ? (
          <Text style={styles.hint} testID="leitstand-inbox-snoozed">
            {t("leitstand.inbox.snoozedCount", { count: inbox.snoozedCount })}
          </Text>
        ) : null}
        {count > 0 ? <Text style={styles.hintEnd}>{t("leitstand.inbox.hint")}</Text> : null}
      </View>
      {count === 0 ? (
        <View style={styles.empty} testID="leitstand-inbox-empty">
          <LeitstandPanda mood="sleep" size={64} />
          <View style={styles.emptyText}>
            <Text style={styles.emptyTitle}>{t("leitstand.inbox.empty")}</Text>
            <Text style={styles.reason}>{t("leitstand.inbox.emptyHint")}</Text>
          </View>
        </View>
      ) : (
        inbox.items.map((item, index) => (
          <InboxRow key={item.id} item={item} isFirst={index === 0} snooze={inbox.snooze} />
        ))
      )}
    </View>
  );
}

function hasAgentReply(
  item: InboxItem,
): item is Extract<InboxItem, { kind: "question" | "finished" }> {
  return item.kind === "question" || item.kind === "finished";
}

function InboxRow({
  item,
  isFirst,
  snooze,
}: {
  item: InboxItem;
  isFirst: boolean;
  snooze: SnoozableInbox["snooze"];
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const buttonSize: ButtonSize = isCompact ? "md" : "sm";
  const testID = `leitstand-inbox-item-${item.kind}`;
  return (
    <View style={isFirst ? styles.row : [styles.row, styles.rowBorder]} testID={testID}>
      <View style={styles.glyph}>
        <StatusGlyph name={glyphForInboxKind(item.kind)} size={16} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.line}>
          {item.projectName ? <ProjectTag name={item.projectName} /> : null}
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={[styles.kind, kindStyle(item.kind)]}>{t(KIND_LABEL_KEY[item.kind])}</Text>
          <AgeText date={item.since} />
        </View>
        {hasAgentReply(item) ? (
          <>
            <InboxReplyPreview
              serverId={item.serverId}
              agentId={item.agentId}
              fallback={describeReason(item, t)}
              style={styles.reason}
            />
            {item.agentId ? (
              <InboxReplyInput serverId={item.serverId} agentId={item.agentId} testID={testID} />
            ) : null}
          </>
        ) : (
          <Text style={styles.reason}>{describeReason(item, t)}</Text>
        )}
      </View>
      <View style={isCompact ? [styles.actions, styles.actionsCompact] : styles.actions}>
        <InboxActions item={item} size={buttonSize} testID={testID} />
        <SnoozeMenu itemId={item.id} size={buttonSize} snooze={snooze} testID={testID} />
      </View>
    </View>
  );
}

// Row actions are secondary, not outline: the outline border is the inbox surface's own colour.
function InboxActions({
  item,
  size,
  testID,
}: {
  item: InboxItem;
  size: ButtonSize;
  testID: string;
}) {
  const { t } = useTranslation();
  const openSession = useCallback(() => {
    if (item.kind === "schedule_error") return;
    navigateToWorkspace({
      serverId: item.serverId,
      workspaceId: item.workspaceId,
      target: sessionTarget(item),
    });
  }, [item]);

  switch (item.kind) {
    case "schedule_error":
      return <ScheduleErrorActions item={item} size={size} testID={testID} />;
    case "checks_failed":
    case "merge_ready":
      return (
        <>
          <PullRequestButton url={item.pullRequest.url} size={size} testID={testID} />
          {item.kind === "checks_failed" ? (
            <Button variant="ghost" size={size} onPress={openSession} testID={`${testID}-open`}>
              {t("leitstand.inbox.actions.open")}
            </Button>
          ) : null}
        </>
      );
    default:
      return (
        <>
          <Button variant="secondary" size={size} onPress={openSession} testID={`${testID}-open`}>
            {t(PRIMARY_ACTION_KEY[item.kind])}
          </Button>
          {item.kind === "question" || item.kind === "finished" ? (
            <MarkDoneButton
              serverId={item.serverId}
              workspaceId={item.workspaceId}
              done={false}
              size={size}
              testID={testID}
            />
          ) : null}
        </>
      );
  }
}

/** The agent that asked or failed opens directly; otherwise the workspace picks its attention tab. */
function sessionTarget(item: SessionInboxItem): WorkspaceTabTarget | undefined {
  if (item.kind === "permission") return { kind: "agent", agentId: item.agentId };
  if (item.kind === "agent_error" && item.agentId) return { kind: "agent", agentId: item.agentId };
  return undefined;
}

const PRIMARY_ACTION_KEY = {
  permission: "leitstand.inbox.actions.review",
  question: "leitstand.inbox.actions.reply",
  agent_error: "leitstand.inbox.actions.open",
  finished: "leitstand.inbox.actions.view",
} as const;

function PullRequestButton({
  url,
  size,
  testID,
}: {
  url: string;
  size: ButtonSize;
  testID: string;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    void openExternalUrl(url).catch(console.error);
  }, [url]);
  return (
    <Button
      variant="secondary"
      size={size}
      onPress={open}
      accessibilityRole="link"
      testID={`${testID}-open-pr`}
    >
      {t("leitstand.inbox.actions.openPr")}
    </Button>
  );
}

type RunState = "idle" | "pending" | "failed";

function ScheduleErrorActions({
  item,
  size,
  testID,
}: {
  item: ScheduleErrorInboxItem;
  size: ButtonSize;
  testID: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { runScheduleNow } = useScheduleMutations({ serverId: item.serverId });
  const [runState, setRunState] = useState<RunState>("idle");
  const runAgain = useCallback(() => {
    setRunState("pending");
    runScheduleNow(item.scheduleId).then(
      () => setRunState("idle"),
      () => setRunState("failed"),
    );
  }, [item.scheduleId, runScheduleNow]);
  const openLog = useCallback(() => {
    if (item.workspaceId) {
      navigateToWorkspace({ serverId: item.serverId, workspaceId: item.workspaceId });
      return;
    }
    router.push(buildSchedulesRoute());
  }, [item.serverId, item.workspaceId, router]);

  return (
    <>
      {runState === "failed" ? (
        <Text style={styles.error}>{t("leitstand.inbox.actions.runFailed")}</Text>
      ) : null}
      <Button
        variant="secondary"
        size={size}
        onPress={runAgain}
        loading={runState === "pending"}
        disabled={runState === "pending"}
        testID={`${testID}-run-again`}
      >
        {runState === "pending"
          ? t("leitstand.inbox.actions.running")
          : t("leitstand.inbox.actions.runAgain")}
      </Button>
      <Button variant="ghost" size={size} onPress={openLog} testID={`${testID}-open`}>
        {t("leitstand.inbox.actions.open")}
      </Button>
    </>
  );
}

function SnoozeMenu({
  itemId,
  size,
  snooze,
  testID,
}: {
  itemId: string;
  size: ButtonSize;
  snooze: SnoozableInbox["snooze"];
  testID: string;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        style={size === "md" ? styles.snoozeTriggerLarge : styles.snoozeTrigger}
        accessibilityRole="button"
        accessibilityLabel={t("leitstand.inbox.actions.later")}
        testID={`${testID}-later`}
      >
        <Text style={styles.snoozeLabel}>{`${t("leitstand.inbox.actions.later")} ▾`}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} sheetTitle={t("leitstand.inbox.actions.later")}>
        <SnoozeOptions itemId={itemId} snooze={snooze} testID={testID} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Rendered while the menu is open, so the offered times follow the clock at that moment.
function SnoozeOptions({
  itemId,
  snooze,
  testID,
}: {
  itemId: string;
  snooze: SnoozableInbox["snooze"];
  testID: string;
}) {
  const now = new Date();
  return availableSnoozeOptions(now).map((option) => (
    <SnoozeItem
      key={option}
      itemId={itemId}
      option={option}
      untilLabel={TIME_FORMAT.format(snoozeUntil(option, now))}
      snooze={snooze}
      testID={`${testID}-snooze-${option}`}
    />
  ));
}

function SnoozeItem({
  itemId,
  option,
  untilLabel,
  snooze,
  testID,
}: {
  itemId: string;
  option: SnoozeOption;
  untilLabel: string;
  snooze: SnoozableInbox["snooze"];
  testID: string;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => snooze(itemId, option), [itemId, option, snooze]);
  const trailing = useMemo(
    () => (
      <Text dataSet={MONO_FONT_DATASET} style={styles.menuTime}>
        {untilLabel}
      </Text>
    ),
    [untilLabel],
  );
  return (
    <DropdownMenuItem onSelect={select} trailing={trailing} testID={testID}>
      {t(SNOOZE_LABEL_KEY[option])}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  inbox: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  count: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
    color: theme.colors.statusWarning,
    fontVariant: ["tabular-nums"],
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  hintEnd: {
    marginLeft: "auto",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  empty: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  emptyText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  emptyTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  glyph: {
    width: 16,
    alignSelf: "flex-start",
    paddingTop: theme.spacing[0.5],
  },
  rowBody: {
    flex: 1,
    minWidth: 200,
    gap: theme.spacing[0.5],
  },
  line: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  kind: {
    fontSize: theme.fontSize.sm,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  kindAsk: {
    color: theme.colors.statusWarning,
  },
  kindError: {
    color: theme.colors.statusDanger,
  },
  kindMerge: {
    color: theme.colors.statusMerged,
  },
  kindDone: {
    color: theme.colors.foreground,
  },
  reason: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionsCompact: {
    width: "100%",
    paddingLeft: 16 + theme.spacing[3],
    flexWrap: "wrap",
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  snoozeTrigger: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  snoozeTriggerLarge: {
    height: 44,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
  },
  snoozeLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  menuTime: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));

// A function, not a table: styles must be read at render time (docs/unistyles.md).
function kindStyle(kind: InboxKind) {
  switch (kind) {
    case "permission":
    case "question":
      return styles.kindAsk;
    case "agent_error":
    case "schedule_error":
    case "checks_failed":
      return styles.kindError;
    case "merge_ready":
      return styles.kindMerge;
    case "finished":
      return styles.kindDone;
  }
}
