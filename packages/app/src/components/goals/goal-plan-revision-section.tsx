import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, PlanRevision, PlanRevisionOp } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import {
  decidedPlanRevisions,
  pendingPlanRevision,
  revisionOpRows,
  type RevisionOpRow,
} from "@/goals/goal-plan-revisions";
import { useGoalDecisionMutations } from "@/hooks/use-goal-decision-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import { GoalFeedbackSheet } from "./goal-feedback-sheet";
import { useKeyedError } from "./use-keyed-error";

const REVISION_BADGE: Record<string, StatusBadgeVariant> = {
  pending: "warning",
  applied: "success",
  rejected: "error",
  superseded: "muted",
  abandoned: "muted",
};

const KNOWN_STATUSES = new Set(Object.keys(REVISION_BADGE));

/**
 * Changes to the plan after it was approved: the one waiting for you, with Approve and Reject,
 * then the decided ones. Renders nothing for a goal whose plan never changed.
 */
export function GoalPlanRevisionSection({
  serverId,
  goal,
}: {
  serverId: string;
  goal: Goal;
}): ReactElement | null {
  const { t } = useTranslation();
  const canDecide = useHostFeature(serverId, "goalPlanRevision");
  const { approvePlanRevision, rejectPlanRevision, pendingRevisionId } = useGoalDecisionMutations({
    serverId,
  });
  const [isRejectOpen, setIsRejectOpen] = useState(false);
  const pending = pendingPlanRevision(goal);
  const decided = useMemo(() => decidedPlanRevisions(goal), [goal]);
  const pendingId = pending?.id ?? null;
  // An error belongs to the revision it was about; a new or decided one starts clean.
  const [error, setError] = useKeyedError(pendingId ?? "");

  const handleApprove = useCallback(() => {
    if (!pendingId) return;
    setError(null);
    approvePlanRevision({ goalId: goal.id, revisionId: pendingId }).catch((cause: unknown) =>
      setError(toErrorMessage(cause)),
    );
  }, [approvePlanRevision, goal.id, pendingId, setError]);
  const openReject = useCallback(() => {
    setError(null);
    setIsRejectOpen(true);
  }, [setError]);
  const closeReject = useCallback(() => {
    setError(null);
    setIsRejectOpen(false);
  }, [setError]);
  const handleReject = useCallback(
    (feedback: string) => {
      if (!pendingId) return;
      setError(null);
      rejectPlanRevision({
        goalId: goal.id,
        revisionId: pendingId,
        ...(feedback ? { feedback } : {}),
      })
        .then(() => setIsRejectOpen(false))
        .catch((cause: unknown) => setError(toErrorMessage(cause)));
    },
    [goal.id, pendingId, rejectPlanRevision, setError],
  );
  const rejectCopy = useMemo(
    () => ({
      title: t("goals.revisions.rejectTitle"),
      label: t("goals.revisions.rejectLabel"),
      placeholder: t("goals.revisions.rejectPlaceholder"),
      send: t("goals.revisions.rejectSend"),
    }),
    [t],
  );

  if (!pending && decided.length === 0) {
    return null;
  }
  const isSending = pendingId !== null && pendingRevisionId === pendingId;

  return (
    <SettingsSection title={t("goals.revisions.title")} testID="goal-plan-revisions">
      <SettingsCard>
        {pending ? (
          <RevisionRow goal={goal} revision={pending} compare>
            {canDecide ? (
              <View style={styles.actions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={handleApprove}
                  loading={isSending && !isRejectOpen}
                  disabled={isSending}
                  testID="goal-revision-approve"
                >
                  {t("goals.revisions.approve")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onPress={openReject}
                  disabled={isSending}
                  testID="goal-revision-reject"
                >
                  {t("goals.revisions.reject")}
                </Button>
              </View>
            ) : null}
            {/* While the reject sheet is open, its error shows there and only there. */}
            {error && !isRejectOpen ? <Text style={styles.error}>{error}</Text> : null}
          </RevisionRow>
        ) : null}
        {decided.map((revision) => (
          <RevisionRow key={revision.id} goal={goal} revision={revision} compare={false} />
        ))}
      </SettingsCard>
      {isRejectOpen && pending ? (
        <GoalFeedbackSheet
          copy={rejectCopy}
          subject={pending.reason || goal.title}
          isRequired={false}
          isSending={isSending}
          error={error}
          onSend={handleReject}
          onClose={closeReject}
          testID="goal-revision-reject-sheet"
        />
      ) : null}
    </SettingsSection>
  );
}

function RevisionRow({
  goal,
  revision,
  compare,
  children,
}: {
  goal: Goal;
  revision: PlanRevision;
  /** Read each replace against the current plan; only while the revision is not applied. */
  compare: boolean;
  children?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  const status = KNOWN_STATUSES.has(revision.status) ? revision.status : null;
  const source =
    revision.source === "lead"
      ? t("goals.revisions.proposedByLead")
      : t("goals.revisions.proposedByPerson");
  return (
    <View style={styles.row} testID={`goal-revision-${revision.id}`}>
      <View style={styles.header}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{revision.reason || source}</Text>
          <Text style={settingsStyles.rowHint}>{source}</Text>
        </View>
        <StatusBadge
          label={status ? t(`goals.revisions.status.${status}`) : revision.status}
          variant={status ? REVISION_BADGE[status] : "muted"}
        />
      </View>
      {/* Decided revisions can arrive without their ops (left out, not "changed nothing"). */}
      {revision.ops.length > 0 ? (
        <GoalRevisionOps goal={goal} ops={revision.ops} compare={compare} />
      ) : null}
      {revision.decisionReason ? (
        <Text style={settingsStyles.rowHint} numberOfLines={4}>
          {revision.decisionReason}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

const OP_MARK: Record<RevisionOpRow["kind"], string> = { add: "+", replace: "~", remove: "−" };

/**
 * A plan change as one line per task: added, changed or removed, with what a change touches.
 * Shared by plan revisions and a recovery's plan change.
 */
export function GoalRevisionOps({
  goal,
  ops,
  compare,
}: {
  goal: Goal;
  ops: readonly PlanRevisionOp[];
  compare: boolean;
}): ReactElement {
  const rows = useMemo(() => revisionOpRows(goal, ops, { compare }), [compare, goal, ops]);
  return (
    <View style={styles.ops} testID="goal-revision-ops">
      {rows.map((row) => (
        <RevisionOpLine key={`${row.kind}-${row.taskId}`} row={row} />
      ))}
    </View>
  );
}

function RevisionOpLine({ row }: { row: RevisionOpRow }): ReactElement {
  const { t } = useTranslation();
  const hints: string[] = [];
  if (row.previousTitle) {
    hints.push(t("goals.revisions.renamed", { title: row.previousTitle }));
  }
  if (row.changed.length > 0) {
    hints.push(
      t("goals.revisions.changed", {
        fields: row.changed.map((field) => t(`goals.revisions.fields.${field}`)).join(", "),
      }),
    );
  }
  if (row.kind !== "remove" && row.dependsOn.length > 0) {
    hints.push(t("goals.detail.dependsOn", { ids: row.dependsOn.join(", ") }));
  }
  return (
    <View style={styles.op} testID={`goal-revision-op-${row.kind}-${row.taskId}`}>
      {/* The sentence beside it says add, change or remove; the mark is for the eye only. */}
      <Text
        style={[styles.opMark, markStyle(row.kind)]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {OP_MARK[row.kind]}
      </Text>
      <View style={settingsStyles.rowContent}>
        <Text style={styles.opTitle}>
          {t(`goals.revisions.op.${row.kind}`, { id: row.taskId, title: row.title })}
        </Text>
        {hints.length > 0 ? <Text style={settingsStyles.rowHint}>{hints.join(" · ")}</Text> : null}
      </View>
    </View>
  );
}

function markStyle(kind: RevisionOpRow["kind"]) {
  if (kind === "add") return styles.markAdd;
  if (kind === "remove") return styles.markRemove;
  return styles.markReplace;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  ops: {
    gap: theme.spacing[2],
  },
  op: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  opMark: {
    width: 16,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  markAdd: {
    color: theme.colors.statusSuccess,
  },
  markReplace: {
    color: theme.colors.statusWarning,
  },
  markRemove: {
    color: theme.colors.statusDanger,
  },
  opTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
