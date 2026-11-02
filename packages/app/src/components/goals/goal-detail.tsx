import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Pause, Play } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalConfig, GoalEvent } from "@getpaseo/protocol/goal/types";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { canAcknowledgeGoal } from "@/goals/goal-attention";
import { canApproveGoalPlan, isGoalTerminal } from "@/goals/goal-derivation";
import { goalBadge } from "@/goals/goal-labels";
import {
  goalControlsAvailable,
  goalRetryLabelKey,
  isIntegrationFailedChangeSet,
  goalFailedOnPermission,
  goalFailedOnQuestion,
  goalGuidance,
  goalSteps,
} from "@/goals/goal-phase";
import { goalDeadline } from "@/goals/goal-progress";
import { buildFollowUpPrefill, canStartFollowUp } from "@/goals/goal-follow-up";
import { canAccept, criterionState } from "@/goals/goal-accept";
import {
  canAddFixTasks,
  goalFailureView,
  guidanceTextCut,
  recoverAgainView,
  verificationRoundView,
  type GoalFailureView,
} from "@/goals/goal-recovery";
import { goalTeam } from "@/goals/goal-settings";
import { goalWaitingOnDetail } from "@/goals/goal-waiting-on";
import { useGoalProjectOptions } from "@/goals/use-goal-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useGoalDetail } from "@/hooks/use-goals";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { useHostFeature } from "@/runtime/host-features";
import { useGoalLaunchStore } from "@/stores/goal-launch-store";
import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { formatDuration } from "@/utils/time";
import { GoalAcceptButton } from "./goal-accept-sheet";
import { GoalActivity } from "./goal-activity";
import { GoalChangeSetList } from "./goal-change-set-list";
import { GoalFeedbackSheet } from "./goal-feedback-sheet";
import { GoalActionsMenu } from "./goal-actions-menu";
import { GoalPriorityBadge, GoalProjectLine } from "./goal-list";
import { GoalPlanRevisionSection } from "./goal-plan-revision-section";
import { GoalProgressPanel } from "./goal-progress-panel";
import { GoalRecoverButton } from "./goal-recover-sheet";
import { GoalRecoverySection } from "./goal-recovery-section";
import { useRetryTimeChoice } from "./goal-retry-time-sheet";
import { GoalSettingsSheet } from "./goal-settings-sheet";
import { GoalStepper } from "./goal-stepper";
import { GoalTaskList, OpenAgentButton } from "./goal-task-list";
import { GoalUsageSection } from "./goal-usage-section";

export function GoalDetail({
  serverId,
  goalId,
  onBack,
  onDeleted,
}: {
  serverId: string;
  goalId: string;
  onBack: () => void;
  /** Called once the goal shown here was deleted. */
  onDeleted?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { loadState, isError, refetch } = useGoalDetail({ serverId, goalId });

  let body: ReactElement;
  if (loadState.status === "loaded" && loadState.data.goal) {
    body = (
      <GoalDetailContent
        serverId={serverId}
        goal={loadState.data.goal}
        events={loadState.data.events}
        onDeleted={onDeleted}
      />
    );
  } else if (loadState.status === "loaded") {
    body = <Text style={styles.message}>{t("goals.detail.notFound")}</Text>;
  } else if (isError) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("goals.detail.loadFailed")}</Text>
        <Button variant="ghost" onPress={refetch}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else {
    body = <LoadingSpinner size="large" color={styles.spinner.color} />;
  }

  return (
    <View style={styles.container} testID="goal-detail">
      <View style={styles.backRow}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ChevronLeft}
          onPress={onBack}
          testID="goal-detail-back"
        >
          {t("common.actions.back")}
        </Button>
      </View>
      {body}
    </View>
  );
}

function GoalDetailContent({
  serverId,
  goal,
  events,
  onDeleted,
}: {
  serverId: string;
  goal: Goal;
  events: GoalEvent[];
  onDeleted?: () => void;
}): ReactElement {
  const steps = useMemo(() => goalSteps(goal), [goal]);
  const hasControls = useHostFeature(serverId, "goalControls");
  return (
    <View>
      <GoalSummary serverId={serverId} goal={goal} events={events} onDeleted={onDeleted} />
      {steps ? (
        <View style={styles.stepper}>
          <GoalStepper steps={steps} />
        </View>
      ) : null}
      <GoalGuidanceBanner serverId={serverId} goal={goal} events={events} />
      <GoalRecoverySection serverId={serverId} goal={goal} events={events} />
      {goal.config ? <GoalProgressPanel goal={goal} /> : null}
      {goal.config ? <GoalUsageSection serverId={serverId} goal={goal} /> : null}
      <GoalChangeSetList serverId={serverId} goal={goal} />
      <GoalPlanRevisionSection serverId={serverId} goal={goal} />
      <GoalTaskList
        serverId={serverId}
        goal={goal}
        events={events}
        canRetryTasks={goalControlsAvailable(goal, hasControls).canRetryTasks}
      />
      <GoalCriteria goal={goal} />
      {goal.config ? <GoalTeamSection config={goal.config} /> : null}
      <GoalActivity goal={goal} events={events} />
    </View>
  );
}

/** After a retry restarted the time limit, how much of it is left; null otherwise. */
function timeLimitRestartedLabel(t: TFunction, goal: Goal, now: number): string | null {
  const deadline = goal.timeBaseAt ? goalDeadline(goal, now) : null;
  if (deadline?.kind !== "running") {
    return null;
  }
  const minutes = Math.floor(deadline.remainingMs / 60_000) * 60_000;
  return t("goals.detail.timeBase", { time: formatDuration(minutes) });
}

function GoalSummary({
  serverId,
  goal,
  events,
  onDeleted,
}: {
  serverId: string;
  goal: Goal;
  events: GoalEvent[];
  onDeleted?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useGoalMutations({ serverId });
  const { approvePlan, cancelGoal, isApproving, isCancelling } = mutations;
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const hasControls = useHostFeature(serverId, "goalControls");
  const retryChoice = useRetryTimeChoice({ serverId, goal, events });
  const canAcknowledge = useHostFeature(serverId, "goalAcknowledge");
  const configEdit = useHostFeature(serverId, "goalConfigEdit");
  const integrationRetry = useHostFeature(serverId, "goalIntegrationRetry");
  const reworkRetry = useHostFeature(serverId, "goalReworkRetry");
  const controls = goalControlsAvailable(goal, hasControls, {
    configEdit,
    integrationRetry,
    reworkRetry,
  });
  const showDismiss = canAcknowledge && canAcknowledgeGoal(goal);
  const showApprove = canApproveGoalPlan(goal.status);
  const showCancel = !isGoalTerminal(goal.status);
  const badge = goalBadge(t, goal);
  const projects = useGoalProjectOptions(serverId);
  const created = useCompactTimeAgo(useMemo(() => new Date(goal.createdAt), [goal.createdAt]));
  const acknowledged = useCompactTimeAgo(
    useMemo(
      () => new Date(goal.acknowledgedAt ?? goal.createdAt),
      [goal.acknowledgedAt, goal.createdAt],
    ),
  );
  const archivedAgo = useCompactTimeAgo(
    useMemo(() => new Date(goal.archivedAt ?? goal.createdAt), [goal.archivedAt, goal.createdAt]),
  );
  const now = useRelativeTimeTick({ enabled: Boolean(goal.timeBaseAt) && showCancel });
  const lead = useMemo(
    () =>
      goal.leadAgentId ? { agentId: goal.leadAgentId, workspaceId: goal.leadWorkspaceId } : null,
    [goal.leadAgentId, goal.leadWorkspaceId],
  );
  const meta = [t("goals.detail.created", { time: created })];
  if (goal.integration) {
    meta.push(t("goals.detail.branch", { branch: goal.integration.branch }));
  }
  if (goal.acknowledgedAt) {
    meta.push(t("goals.detail.dismissed", { time: acknowledged }));
  }
  if (goal.archivedAt) {
    meta.push(t("goals.detail.archivedAt", { time: archivedAgo }));
  }
  const restarted = timeLimitRestartedLabel(t, goal, now);
  if (restarted) {
    meta.push(restarted);
  }

  const handleApprove = useCallback(() => {
    setActionError(null);
    approvePlan(goal.id).catch((error: unknown) => setActionError(toErrorMessage(error)));
  }, [approvePlan, goal.id]);

  const handleCancel = useCallback(() => {
    void confirmDialog({
      title: t("goals.detail.cancelConfirmTitle"),
      message: t("goals.detail.cancelConfirmMessage"),
      confirmLabel: t("goals.detail.cancelGoal"),
      cancelLabel: t("goals.detail.keepGoal"),
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return null;
      }
      setActionError(null);
      return cancelGoal(goal.id).catch((error: unknown) => setActionError(toErrorMessage(error)));
    });
  }, [cancelGoal, goal.id, t]);

  const run = useCallback((action: Promise<void>) => {
    setActionError(null);
    action.catch((error: unknown) => setActionError(toErrorMessage(error)));
  }, []);
  const { rejectPlan, pause, resume, acknowledge } = mutations;
  const handlePause = useCallback(() => run(pause(goal.id)), [goal.id, pause, run]);
  const handleResume = useCallback(() => run(resume(goal.id)), [goal.id, resume, run]);
  const retryWithChoice = retryChoice.retry;
  const handleRetry = useCallback(() => run(retryWithChoice()), [retryWithChoice, run]);
  const handleDismiss = useCallback(() => run(acknowledge(goal.id)), [acknowledge, goal.id, run]);
  const openReject = useCallback(() => setIsRejectOpen(true), []);
  const closeReject = useCallback(() => setIsRejectOpen(false), []);
  const handleReject = useCallback(
    (feedback: string) => {
      setActionError(null);
      rejectPlan({ goalId: goal.id, ...(feedback ? { feedback } : {}) })
        .then(() => setIsRejectOpen(false))
        .catch((error: unknown) => setActionError(toErrorMessage(error)));
    },
    [goal.id, rejectPlan],
  );
  const rejectCopy = useMemo(
    () => ({
      title: t("goals.detail.rejectPlanTitle"),
      label: t("goals.detail.rejectPlanLabel"),
      placeholder: t("goals.detail.rejectPlanPlaceholder"),
      send: t("goals.detail.rejectPlanSend"),
    }),
    [t],
  );

  const handleCopyId = useCallback(() => {
    void Clipboard.setStringAsync(goal.id);
    toast.copied(t("goals.detail.goalId"));
  }, [goal.id, t, toast]);

  return (
    <View style={styles.summary}>
      <View style={styles.titleRow}>
        <Text style={styles.title} testID="goal-detail-title">
          {goal.title}
        </Text>
        <GoalPriorityBadge goal={goal} />
        {goal.archivedAt ? <StatusBadge label={t("goals.archived.badge")} /> : null}
        <StatusBadge label={badge.label} variant={badge.variant} />
        <View style={styles.titleMenu}>
          <GoalActionsMenu
            serverId={serverId}
            goal={goal}
            events={events}
            onDeleted={onDeleted}
            testID="goal-detail-menu"
          />
        </View>
      </View>
      <GoalProjectLine projects={projects} cwd={goal.config?.cwd} testID="goal-detail-project" />
      {goal.objective ? <Text style={styles.objective}>{goal.objective}</Text> : null}
      <GoalInstructionLine goal={goal} />
      <Text style={styles.meta} numberOfLines={2}>
        {meta.join(" · ")}
      </Text>
      <View style={styles.actions}>
        {showApprove ? (
          <Button
            size="sm"
            variant="default"
            onPress={handleApprove}
            loading={isApproving}
            testID="goal-approve-plan"
          >
            {t("goals.detail.approvePlan")}
          </Button>
        ) : null}
        {controls.canRejectPlan ? (
          <Button size="sm" variant="outline" onPress={openReject} testID="goal-reject-plan">
            {t("goals.detail.rejectPlan")}
          </Button>
        ) : null}
        {controls.canRetry ? (
          <Button
            size="sm"
            variant="default"
            onPress={handleRetry}
            loading={retryChoice.pendingTaskId === ""}
            testID="goal-retry"
          >
            {t(goalRetryLabelKey(controls))}
          </Button>
        ) : null}
        {showDismiss ? (
          <Button
            size="sm"
            variant="outline"
            onPress={handleDismiss}
            loading={mutations.pendingAcknowledgeGoalId === goal.id}
            testID="goal-dismiss"
          >
            {t("goals.detail.dismiss")}
          </Button>
        ) : null}
        {controls.canPause ? (
          <Button
            size="sm"
            variant="outline"
            leftIcon={Pause}
            onPress={handlePause}
            loading={mutations.isPausing}
            testID="goal-pause"
          >
            {t("goals.detail.pause")}
          </Button>
        ) : null}
        {controls.canResume ? (
          <Button
            size="sm"
            variant="secondary"
            leftIcon={Play}
            onPress={handleResume}
            loading={mutations.isPausing}
            testID="goal-resume"
          >
            {t("goals.detail.resume")}
          </Button>
        ) : null}
        {lead ? (
          <OpenAgentButton
            serverId={serverId}
            agent={lead}
            taskId="lead"
            label={t("goals.detail.openLead")}
          />
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Copy}
          onPress={handleCopyId}
          testID="goal-copy-id"
        >
          {t("goals.detail.copyId")}
        </Button>
        {showCancel ? (
          <Button
            size="sm"
            variant="destructive"
            onPress={handleCancel}
            loading={isCancelling}
            testID="goal-cancel"
          >
            {t("goals.detail.cancelGoal")}
          </Button>
        ) : null}
      </View>
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
      {isRejectOpen ? (
        <GoalFeedbackSheet
          copy={rejectCopy}
          subject={goal.title}
          isRequired={false}
          isSending={mutations.isRejecting}
          error={actionError}
          onSend={handleReject}
          onClose={closeReject}
          testID="goal-reject-plan-sheet"
        />
      ) : null}
      {retryChoice.sheet}
    </View>
  );
}

/** Your instruction for the goal's workers, given with a recovery or a retry. */
function GoalInstructionLine({ goal }: { goal: Goal }): ReactElement | null {
  const { t } = useTranslation();
  const text = goal.guidance?.goal;
  if (!text) {
    return null;
  }
  return (
    <>
      {/* Ahead of the text, so the line limit below never hides it. */}
      {guidanceTextCut(goal, text) ? (
        <Text style={styles.meta}>{t("goals.detail.guidanceTruncated")}</Text>
      ) : null}
      <Text style={styles.meta} numberOfLines={3} testID="goal-detail-guidance">
        {t("goals.detail.yourInstruction", { text })}
      </Text>
    </>
  );
}

function GoalGuidanceBanner({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
}): ReactElement {
  const { t } = useTranslation();
  const guidance = goalGuidance(goal);
  const failure = useMemo(() => goalFailureView(goal), [goal]);
  const description = [t(`goals.guidance.${guidance.phase}.description`, guidance.params)];
  // The reason once, as one line; "Show details" holds the rest.
  if (failure?.summary) {
    description.unshift(failure.summary);
  }
  // The phase explains the stage; the waiting line names the tasks or changes it is on.
  const waiting = goalWaitingOnDetail(t, goal);
  if (waiting) {
    description.push(waiting);
  }
  // Hints, Recover and the follow-up need a managed goal; the details need more than the summary.
  const hasBody = failure !== null && (failure.hasDetails || goal.config !== null);
  return (
    <View style={styles.banner} testID={`goal-guidance-${guidance.phase}`}>
      <Alert
        variant={guidance.tone}
        title={
          failure?.recoveryNeedsYou
            ? t("goals.failure.needsYouTitle")
            : t(`goals.guidance.${guidance.phase}.title`)
        }
        description={description.join("\n")}
      >
        {failure && hasBody ? (
          <View style={styles.bannerBody}>
            {failure.hasDetails ? <GoalFailureDetails failure={failure} /> : null}
            <GoalFailureHints serverId={serverId} goal={goal} />
            <GoalFailureActions serverId={serverId} goal={goal} events={events} />
          </View>
        ) : null}
      </Alert>
    </View>
  );
}

/** What to fix before trying again, for a run that stopped on a request or a merge that failed. */
function GoalFailureHints({
  serverId,
  goal,
}: {
  serverId: string;
  goal: Goal;
}): ReactElement | null {
  const { t } = useTranslation();
  const configEdit = useHostFeature(serverId, "goalConfigEdit");
  const integrationRetry = useHostFeature(serverId, "goalIntegrationRetry");
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const openSettings = useCallback(() => setIsEditingSettings(true), []);
  const closeSettings = useCallback(() => setIsEditingSettings(false), []);
  // The fix for a run that ended on a permission request is a different policy, then a retry.
  const showPermissionHint =
    configEdit && goal.config !== null && !goal.archivedAt && goalFailedOnPermission(goal);
  // A failed merge is fixed in the integration worktree, then merged again by the retry.
  const showMergeHint =
    integrationRetry &&
    goal.status === "failed" &&
    !goal.archivedAt &&
    goal.changeSets.some(isIntegrationFailedChangeSet);
  if (!showPermissionHint && !showMergeHint) {
    return null;
  }
  return (
    <>
      {showPermissionHint ? (
        <View style={styles.bannerHint} testID="goal-permission-failure-hint">
          <Text style={styles.meta}>
            {goalFailedOnQuestion(goal)
              ? t("goals.detail.questionFailureHint")
              : t("goals.detail.permissionFailureHint")}
          </Text>
          <View style={styles.bannerActions}>
            <Button
              size="sm"
              variant="outline"
              onPress={openSettings}
              testID="goal-permission-failure-edit-settings"
            >
              {t("goals.actions.editSettings")}
            </Button>
          </View>
        </View>
      ) : null}
      {showMergeHint ? (
        <View style={styles.bannerHint} testID="goal-merge-failure-hint">
          <Text style={styles.meta}>
            {t("goals.detail.mergeFailureHint", {
              path: goal.integration?.cwd ?? goal.integration?.branch ?? "",
            })}
          </Text>
        </View>
      ) : null}
      {isEditingSettings && goal.config ? (
        <GoalSettingsSheet
          serverId={serverId}
          goal={goal}
          config={goal.config}
          onClose={closeSettings}
        />
      ) : null}
    </>
  );
}

/** "Show details" under a failed goal's one-line reason: the full reason, what failed first, the unmet criteria. */
function GoalFailureDetails({ failure }: { failure: GoalFailureView }): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.failureDetails}>
      <View style={styles.bannerActions}>
        <Button
          variant="ghost"
          size="xs"
          leftIcon={expanded ? ChevronDown : ChevronRight}
          onPress={toggle}
          accessibilityState={expandedState}
          testID="goal-failure-details-toggle"
        >
          {expanded ? t("goals.failure.hideDetails") : t("goals.failure.showDetails")}
        </Button>
      </View>
      {expanded ? (
        <View style={styles.failureDetails} testID="goal-failure-details">
          {failure.fullReason ? (
            <Text style={styles.detailText} selectable>
              {failure.fullReasonIsLead
                ? t("goals.failure.leadSaid", { text: failure.fullReason })
                : failure.fullReason}
            </Text>
          ) : null}
          {failure.originalFailure ? (
            <Text style={styles.detailText} selectable>
              {t("goals.failure.originalFailure", { text: failure.originalFailure })}
            </Text>
          ) : null}
          {failure.unmet.length > 0 ? (
            <View style={styles.failureList}>
              <Text style={styles.detailLabel}>{t("goals.failure.unmetCriteria")}</Text>
              {failure.unmet.map((criterion) => (
                <Text key={criterion.id} style={styles.detailText}>
                  {t("goals.failure.listItem", { text: criterion.text })}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * What you can do about a failed goal: recover again with your own instructions, or start a
 * follow-up goal from what it merged. Retry stays with the goal's other controls above.
 */
function GoalFailureActions({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
}): ReactElement | null {
  const { t } = useTranslation();
  const hasRecovery = useHostFeature(serverId, "goalRecovery");
  const reworkRetry = useHostFeature(serverId, "goalReworkRetry");
  const verificationRecovery = useHostFeature(serverId, "goalVerificationRecovery");
  const recover = recoverAgainView(goal, hasRecovery, reworkRetry);
  // COMPAT(goalVerificationRecovery): added in v0.13.14, remove gate after 2027-10-28.
  const showFixTasks = verificationRecovery && recover.kind === "available" && canAddFixTasks(goal);
  const openLaunch = useGoalLaunchStore((state) => state.open);
  const showFollowUp = canStartFollowUp(goal);
  // COMPAT(goalAccept): added in v0.13.14, remove gate after 2027-10-28.
  const hasGoalAccept = useHostFeature(serverId, "goalAccept");
  const showAccept = canAccept(goal, hasGoalAccept);
  const handleFollowUp = useCallback(() => {
    const prefill = buildFollowUpPrefill(goal, {
      title: (title: string) => t("goals.failure.followUpTitle", { title }),
      objectiveIntro: t("goals.failure.followUpObjective", { title: goal.title }),
      unmetIntro: t("goals.failure.followUpUnmet"),
    });
    if (prefill) {
      openLaunch({ serverId, prefill });
    }
  }, [goal, openLaunch, serverId, t]);
  if (recover.kind === "hidden" && !showFollowUp && !showAccept) {
    return null;
  }
  return (
    <View style={styles.failureDetails} testID="goal-failure-actions">
      <View style={styles.failureActions}>
        <GoalRecoverButton serverId={serverId} goal={goal} events={events} />
        {showFollowUp ? (
          <Button size="sm" variant="outline" onPress={handleFollowUp} testID="goal-follow-up">
            {t("goals.failure.followUp")}
          </Button>
        ) : null}
        {showAccept ? <GoalAcceptButton serverId={serverId} goal={goal} /> : null}
      </View>
      {showFixTasks ? (
        <Text style={styles.meta} testID="goal-recover-verification-fix">
          {t("goals.failure.verificationFix")}
        </Text>
      ) : null}
      {recover.kind === "exhausted" ? (
        <Text style={styles.meta} testID="goal-recover-exhausted">
          {t(
            showFollowUp
              ? "goals.failure.noRecoveriesLeftFollowUp"
              : "goals.failure.noRecoveriesLeft",
            { used: recover.used, max: recover.max },
          )}
        </Text>
      ) : null}
    </View>
  );
}

/** Who runs each role, on which provider and model, with what thinking. */
function GoalTeamSection({ config }: { config: GoalConfig }): ReactElement {
  const { t } = useTranslation();
  const team = useMemo(() => goalTeam(config), [config]);
  return (
    <SettingsSection title={t("goals.detail.team")} testID="goal-team">
      <SettingsCard>
        {team.map((member) => (
          <View key={member.role} style={settingsStyles.row} testID={`goal-team-${member.role}`}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t(`goals.detail.roles.${member.role}`)}</Text>
              <Text style={settingsStyles.rowHint} numberOfLines={1}>
                {member.provider}
              </Text>
            </View>
            <Text style={styles.meta} testID={`goal-team-${member.role}-thinking`}>
              {member.thinking
                ? t("goals.detail.thinking", {
                    level: formatThinkingOptionLabel({ id: member.thinking }),
                  })
                : t("goals.detail.thinkingDefault")}
            </Text>
          </View>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

const CRITERION_BADGES: Record<
  ReturnType<typeof criterionState>,
  { key: string; variant: StatusBadgeVariant }
> = {
  verified: { key: "goals.detail.verified", variant: "success" },
  // An accept waived it unverified; the note says why.
  waived: { key: "goals.accept.waived", variant: "warning" },
  unverified: { key: "goals.detail.unverified", variant: "muted" },
};

function GoalCriteria({ goal }: { goal: Goal }): ReactElement {
  const { t } = useTranslation();
  // A recovery that added work cleared every criterion; each badge is about the current round.
  const round = verificationRoundView(goal);
  return (
    <SettingsSection title={t("goals.detail.criteria")}>
      <SettingsCard>
        {round ? (
          <View style={settingsStyles.row} testID="goal-verification-round">
            <Text style={styles.meta}>
              {t(
                round.started
                  ? "goals.detail.verificationRoundStarted"
                  : "goals.detail.verificationRoundPending",
                { round: round.round },
              )}
            </Text>
          </View>
        ) : null}
        {goal.criteria.length === 0 ? (
          <View style={settingsStyles.row}>
            <Text style={styles.meta}>{t("goals.detail.noCriteria")}</Text>
          </View>
        ) : (
          goal.criteria.map((criterion) => (
            <View key={criterion.id} style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{criterion.text}</Text>
                {criterion.evidence ? (
                  <Text style={settingsStyles.rowHint} numberOfLines={4}>
                    {criterion.evidence}
                  </Text>
                ) : null}
              </View>
              <StatusBadge
                label={t(CRITERION_BADGES[criterionState(criterion)].key)}
                variant={CRITERION_BADGES[criterionState(criterion)].variant}
              />
            </View>
          ))
        )}
        {goal.accepted ? (
          <View style={settingsStyles.row} testID="goal-accepted-note">
            <Text style={styles.meta} selectable>
              {t("goals.accept.note", { note: goal.accepted.note })}
            </Text>
          </View>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    gap: theme.spacing[4],
  },
  backRow: {
    flexDirection: "row",
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[4],
  },
  summary: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[6],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  titleMenu: {
    marginLeft: "auto",
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  objective: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  stepper: {
    marginBottom: theme.spacing[4],
  },
  banner: {
    marginBottom: theme.spacing[6],
  },
  bannerHint: {
    gap: theme.spacing[2],
  },
  bannerActions: {
    flexDirection: "row",
  },
  bannerBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[3],
  },
  failureDetails: {
    gap: theme.spacing[2],
  },
  failureList: {
    gap: theme.spacing[1],
  },
  failureActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  detailLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detailText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Static color holder read by the spinner; keeps the muted token without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
