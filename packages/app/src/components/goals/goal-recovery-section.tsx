import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { BlockingLimit } from "@getpaseo/protocol/goal/diagnosis";
import type { Goal, GoalEvent, Recovery } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { formatCompactCount, formatUsd } from "@/goals/goal-progress";
import {
  diagnosisRemedyKey,
  endedRecovery,
  goalDiagnosisView,
  goalRecoveryControls,
  liveRecovery,
  type DiagnosisTaskView,
  type DiagnosisView,
} from "@/goals/goal-recovery";
import { useGoalDecisionMutations } from "@/hooks/use-goal-decision-mutations";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { toErrorMessage } from "@/utils/error-messages";
import { formatDuration } from "@/utils/time";
import { GoalFeedbackSheet } from "./goal-feedback-sheet";
import { GoalRevisionOps } from "./goal-plan-revision-section";
import { GoalReasonText } from "./goal-reason-text";
import { GoalSettingsSheet } from "./goal-settings-sheet";
import { OpenAgentButton } from "./goal-task-list";
import { useKeyedError } from "./use-keyed-error";

const PERSON_BADGE: Record<DiagnosisView["personNeeded"], StatusBadgeVariant> = {
  yes: "warning",
  depends: "muted",
  no: "success",
};

const KNOWN_DECISIONS = new Set(["retry", "revise", "needs_person"]);
const KNOWN_OUTCOMES = new Set(["rejected", "needs_person", "cancelled"]);

/**
 * For a failed goal on a host with `goalRecovery`: the recovery in progress or the one that just
 * ended, then the diagnosis of why the goal stopped.
 */
export function GoalRecoverySection({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
}): ReactElement | null {
  const hasRecovery = useHostFeature(serverId, "goalRecovery");
  if (!hasRecovery || goal.status !== "failed" || !goal.config) {
    return null;
  }
  const recovery = liveRecovery(goal) ?? endedRecovery(goal);
  return (
    <>
      {recovery ? <RecoveryCard serverId={serverId} goal={goal} recovery={recovery} /> : null}
      <DiagnosisCard serverId={serverId} goal={goal} events={events} />
    </>
  );
}

function recoveryTitle(t: TFunction, recovery: Recovery): string {
  if (recovery.status === "ended") {
    return recovery.outcome && KNOWN_OUTCOMES.has(recovery.outcome)
      ? t(`goals.recovery.ended.${recovery.outcome}`)
      : t("goals.recovery.ended.unknown");
  }
  if (recovery.status === "deciding") return t("goals.recovery.state.deciding");
  if (recovery.status === "decided") return t("goals.recovery.state.decided");
  return t("goals.recovery.state.awaiting_approval");
}

function RecoveryCard({
  serverId,
  goal,
  recovery,
}: {
  serverId: string;
  goal: Goal;
  recovery: Recovery;
}): ReactElement {
  const { t } = useTranslation();
  const controls = goalRecoveryControls(goal, true);
  const mutations = useGoalDecisionMutations({ serverId });
  const { decideRecovery, cancelRecovery, pendingRecoveryApproval } = mutations;
  // An error is about one status of the recovery; it goes once the recovery moves on.
  const [error, setError] = useKeyedError(`${recovery.id}:${recovery.status}`);
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const started = useCompactTimeAgo(
    useMemo(() => new Date(recovery.startedAt), [recovery.startedAt]),
  );
  const isLive = recovery.status !== "ended";
  const { leadAgentId, leadWorkspaceId } = recovery;
  const lead = useMemo(
    () =>
      isLive && leadAgentId ? { agentId: leadAgentId, workspaceId: leadWorkspaceId ?? null } : null,
    [isLive, leadAgentId, leadWorkspaceId],
  );
  const target = useMemo(
    () => ({ goalId: goal.id, recoveryId: recovery.id }),
    [goal.id, recovery.id],
  );

  const handleApprove = useCallback(() => {
    setError(null);
    decideRecovery({ ...target, approve: true }).catch((cause: unknown) =>
      setError(toErrorMessage(cause)),
    );
  }, [decideRecovery, setError, target]);
  const openReject = useCallback(() => {
    setError(null);
    setIsRejectOpen(true);
  }, [setError]);
  const closeReject = useCallback(() => {
    setError(null);
    setIsRejectOpen(false);
  }, [setError]);
  const handleReject = useCallback(
    (message: string) => {
      setError(null);
      decideRecovery({ ...target, approve: false, ...(message ? { message } : {}) })
        .then(() => setIsRejectOpen(false))
        .catch((cause: unknown) => setError(toErrorMessage(cause)));
    },
    [decideRecovery, setError, target],
  );
  const handleCancel = useCallback(() => {
    setError(null);
    cancelRecovery(target).catch((cause: unknown) => setError(toErrorMessage(cause)));
  }, [cancelRecovery, setError, target]);
  const rejectCopy = useMemo(
    () => ({
      title: t("goals.recovery.rejectTitle"),
      label: t("goals.recovery.rejectLabel"),
      placeholder: t("goals.recovery.rejectPlaceholder"),
      send: t("goals.recovery.rejectSend"),
    }),
    [t],
  );

  const meta = [t("goals.recovery.started", { time: started })];
  if (recovery.timeMode === "fresh" || recovery.timeMode === "remaining") {
    meta.push(t(`goals.recovery.timeMode.${recovery.timeMode}`));
  }
  const isDeciding = pendingRecoveryApproval !== null;

  return (
    <SettingsSection title={t("goals.recovery.title")} testID="goal-recovery">
      <SettingsCard>
        <View style={styles.row} testID={`goal-recovery-${recovery.status}`}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{recoveryTitle(t, recovery)}</Text>
            <Text style={settingsStyles.rowHint}>{meta.join(" · ")}</Text>
          </View>
          {/* The reason itself is in the banner above; the card keeps the decision, in one line. */}
          {recovery.decision ? <RecoveryDecisionBlock goal={goal} recovery={recovery} /> : null}
          {controls.canDecide || controls.canCancel || lead ? (
            <View style={styles.actions}>
              {controls.canDecide ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={handleApprove}
                  loading={pendingRecoveryApproval === true}
                  disabled={isDeciding}
                  testID="goal-recovery-approve"
                >
                  {t("goals.recovery.approve")}
                </Button>
              ) : null}
              {controls.canDecide ? (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={openReject}
                  disabled={isDeciding}
                  testID="goal-recovery-reject"
                >
                  {t("goals.recovery.reject")}
                </Button>
              ) : null}
              {lead ? (
                <OpenAgentButton
                  serverId={serverId}
                  agent={lead}
                  taskId="recovery-lead"
                  label={t("goals.detail.openLead")}
                />
              ) : null}
              {controls.canCancel ? (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleCancel}
                  loading={mutations.isCancellingRecovery}
                  disabled={isDeciding}
                  testID="goal-recovery-cancel"
                >
                  {t("goals.recovery.cancel")}
                </Button>
              ) : null}
            </View>
          ) : null}
          {/* While the reject sheet is open, its error shows there and only there. */}
          {error && !isRejectOpen ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </SettingsCard>
      {isRejectOpen ? (
        <GoalFeedbackSheet
          copy={rejectCopy}
          subject={goal.title}
          isRequired={false}
          isSending={pendingRecoveryApproval === false}
          error={error}
          onSend={handleReject}
          onClose={closeReject}
          testID="goal-recovery-reject-sheet"
        />
      ) : null}
    </SettingsSection>
  );
}

/** What the recovery's Lead chose: retry with advice, a plan change, or a person must act. */
function RecoveryDecisionBlock({
  goal,
  recovery,
}: {
  goal: Goal;
  recovery: Recovery;
}): ReactElement | null {
  const { t } = useTranslation();
  const decision = recovery.decision;
  if (!decision) {
    return null;
  }
  const label = KNOWN_DECISIONS.has(decision.decision)
    ? t(`goals.recovery.decision.${decision.decision}`)
    : decision.decision;
  const hints = Object.entries(decision.hints ?? {});
  const titleOf = (taskId: string) =>
    goal.tasks.find((task) => task.id === taskId)?.title ?? taskId;
  return (
    <View style={styles.decision} testID="goal-recovery-decision">
      <Text style={styles.decisionLabel}>
        {decision.fallback ? t("goals.recovery.decision.fallback") : label}
      </Text>
      {decision.reason ? (
        <GoalReasonText text={decision.reason} testID="goal-recovery-decision-reason" />
      ) : null}
      {hints.map(([taskId, hint]) => (
        <Text key={taskId} style={settingsStyles.rowHint} numberOfLines={4}>
          {t("goals.recovery.hint", { title: titleOf(taskId), hint })}
        </Text>
      ))}
      {/* goal.inspect carries the ops; a list payload leaves them out once decided. */}
      {decision.ops && decision.ops.length > 0 ? (
        <GoalRevisionOps
          goal={goal}
          ops={decision.ops}
          compare={recovery.status === "awaiting_approval"}
        />
      ) : null}
    </View>
  );
}

function limitValue(limit: BlockingLimit["limit"], value: number | string, locale: string): string {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toLocaleString(locale);
  }
  switch (limit) {
    case "goalTimeoutMinutes":
      return formatDuration(value * 60_000);
    case "maxTotalTokens":
      return formatCompactCount(value);
    case "maxCostUsd":
      return formatUsd(value);
    default:
      return String(value);
  }
}

/** The setting in force, what was used and the smallest value that leaves room. */
function limitHint(t: TFunction, locale: string, limit: BlockingLimit): string {
  const value = (raw: number | string) => limitValue(limit.limit, raw, locale);
  if (limit.limit === "deadlineAt") {
    return t("goals.diagnosis.deadlinePassed", {
      deadline: limit.current === null ? "" : value(limit.current),
    });
  }
  const parts: string[] = [];
  if (limit.current !== null) {
    parts.push(t("goals.diagnosis.limitCurrent", { value: value(limit.current) }));
  }
  if (limit.used !== undefined) {
    parts.push(t("goals.diagnosis.limitUsed", { value: value(limit.used) }));
  }
  if (limit.minimum !== undefined) {
    parts.push(t("goals.diagnosis.limitMinimum", { value: value(limit.minimum) }));
  } else {
    parts.push(t("goals.diagnosis.limitNoMinimum"));
  }
  return parts.join(" · ");
}

function DiagnosisCard({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
}): ReactElement {
  const { t, i18n } = useTranslation();
  const configEdit = useHostFeature(serverId, "goalConfigEdit");
  const verificationRecovery = useHostFeature(serverId, "goalVerificationRecovery");
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const openSettings = useCallback(() => setIsEditingSettings(true), []);
  const closeSettings = useCallback(() => setIsEditingSettings(false), []);
  // A failed goal's diagnosis changes only with time passing the limit; once a minute is enough.
  const now = useRelativeTimeTick({ enabled: true });
  const view = useMemo(() => goalDiagnosisView(goal, events, now), [events, goal, now]);
  const [first, ...more] = view.findings;
  const canEditLimits = configEdit && !goal.archivedAt && view.limits.length > 0;
  const locale = i18n.language;

  return (
    <SettingsSection title={t("goals.diagnosis.title")} testID="goal-diagnosis">
      <SettingsCard>
        <View style={settingsStyles.row} testID={`goal-diagnosis-${view.kind}`}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t(`goals.diagnosis.kind.${view.kind}`)}</Text>
            {first ? (
              <Text style={settingsStyles.rowHint}>
                {t(diagnosisRemedyKey(first, goal, verificationRecovery))}
              </Text>
            ) : null}
          </View>
          <StatusBadge
            label={t(`goals.diagnosis.personNeeded.${view.personNeeded}`)}
            variant={PERSON_BADGE[view.personNeeded]}
          />
        </View>
        {more.map((finding) => (
          <View
            key={finding.kind}
            style={settingsStyles.row}
            testID={`goal-diagnosis-finding-${finding.kind}`}
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t(`goals.diagnosis.kind.${finding.kind}`)}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t(diagnosisRemedyKey(finding, goal, verificationRecovery))}
              </Text>
            </View>
          </View>
        ))}
        {view.tasks.map((task) => (
          <DiagnosisTaskRow key={task.taskId} task={task} />
        ))}
        {view.unchanged.length > 0 ? (
          <View style={settingsStyles.row} testID="goal-diagnosis-unchanged">
            <View style={settingsStyles.rowContent}>
              <Text style={styles.meta}>
                {t("goals.diagnosis.unchanged", { titles: view.unchanged.join(", ") })}
              </Text>
            </View>
          </View>
        ) : null}
        {view.limits.map((limit) => (
          <View
            key={limit.limit}
            style={settingsStyles.row}
            testID={`goal-diagnosis-limit-${limit.limit}`}
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t(`goals.diagnosis.limits.${limit.limit}`)}
              </Text>
              <Text style={settingsStyles.rowHint}>{limitHint(t, locale, limit)}</Text>
            </View>
          </View>
        ))}
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={styles.meta}>
              {[
                t("goals.diagnosis.runsUsed", { used: view.runs.used, max: view.runs.max }),
                t("goals.diagnosis.merged", { count: view.merged }),
              ].join(" · ")}
            </Text>
          </View>
          {/* One way to the settings for every limit above; the sheet holds them all. */}
          {canEditLimits ? (
            <Button variant="outline" onPress={openSettings} testID="goal-diagnosis-edit-settings">
              {t("goals.actions.editSettings")}
            </Button>
          ) : null}
        </View>
      </SettingsCard>
      {isEditingSettings && goal.config ? (
        <GoalSettingsSheet
          serverId={serverId}
          goal={goal}
          config={goal.config}
          onClose={closeSettings}
        />
      ) : null}
    </SettingsSection>
  );
}

function DiagnosisTaskRow({ task }: { task: DiagnosisTaskView }): ReactElement {
  const { t } = useTranslation();
  const meta = [t(`goals.diagnosis.cause.${task.cause}`)];
  if (task.failedRuns > 0) {
    meta.push(t("goals.diagnosis.failedRuns", { count: task.failedRuns }));
  }
  if (task.interruptedRuns > 0) {
    meta.push(t("goals.diagnosis.interruptedRuns", { n: task.interruptedRuns }));
  }
  if (task.blocks.length > 0) {
    meta.push(t("goals.diagnosis.blocks", { titles: task.blocks.join(", ") }));
  }
  return (
    <View style={settingsStyles.row} testID={`goal-diagnosis-task-${task.taskId}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{task.title}</Text>
        <Text style={settingsStyles.rowHint}>{meta.join(" · ")}</Text>
        {task.cause === "worker_blocked" || task.cause === "no_answer" ? (
          <Text style={settingsStyles.rowHint}>
            {t(`goals.diagnosis.causeRemedy.${task.cause}`)}
          </Text>
        ) : null}
        {task.lastError ? (
          <Text style={settingsStyles.rowError} numberOfLines={3}>
            {task.lastError}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  decision: {
    gap: theme.spacing[2],
  },
  decisionLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
