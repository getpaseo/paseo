import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalEvent, GoalTimeMode } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { goalRemainingRunMs, retryNeedsTimeMode } from "@/goals/goal-progress";
import { isTimeLimitRefusal } from "@/goals/goal-recovery";
import { useGoalRetryMutation } from "@/hooks/use-goal-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { toErrorMessage } from "@/utils/error-messages";
import { formatDuration } from "@/utils/time";

const MINUTE_MS = 60_000;

interface RetryTimeChoice {
  /**
   * Retries the goal, or one task. Past the time limit, by this device's clock or by the
   * host's refusal, it opens the time sheet instead. Rejects with any other error.
   */
  retry: (taskId?: string) => Promise<void>;
  /** The task a retry is being sent for, "" for the whole goal, null when none is. */
  pendingTaskId: string | null;
  /** Render this; it is null while the sheet is closed. */
  sheet: ReactElement | null;
}

/**
 * Retry with a choice of how the time limit restarts (`goalTimeBase`). `events`, when the
 * caller has the goal's history, lets the sheet say how much running time `remaining` leaves.
 */
export function useRetryTimeChoice({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events?: readonly GoalEvent[];
}): RetryTimeChoice {
  const { retry: retryGoal, pendingRetryTaskId } = useGoalRetryMutation({ serverId });
  const timeBase = useHostFeature(serverId, "goalTimeBase");
  // The task the open sheet retries: "" for the whole goal, null while closed.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  const open = useCallback(
    (taskId: string | undefined) => {
      setError(null);
      setRemainingMs(events ? goalRemainingRunMs(goal, events, Date.now()) : null);
      setOpenFor(taskId ?? "");
    },
    [events, goal],
  );
  const retry = useCallback(
    async (taskId?: string) => {
      if (timeBase && retryNeedsTimeMode(goal, Date.now())) {
        open(taskId);
        return;
      }
      try {
        await retryGoal({ goalId: goal.id, ...(taskId ? { taskId } : {}) });
      } catch (cause) {
        // This device's clock can be behind the host's.
        if (timeBase && isTimeLimitRefusal(cause)) {
          open(taskId);
          return;
        }
        throw cause;
      }
    },
    [goal, open, retryGoal, timeBase],
  );
  const close = useCallback(() => setOpenFor(null), []);
  const choose = useCallback(
    (timeMode: GoalTimeMode) => {
      if (openFor === null) {
        return;
      }
      setError(null);
      retryGoal({ goalId: goal.id, ...(openFor ? { taskId: openFor } : {}), timeMode })
        .then(() => setOpenFor(null))
        .catch((cause: unknown) => setError(toErrorMessage(cause)));
    },
    [goal.id, openFor, retryGoal],
  );

  const sheet =
    openFor === null ? null : (
      <GoalRetryTimeSheet
        remainingMs={remainingMs}
        isSending={pendingRetryTaskId === openFor}
        error={error}
        onChoose={choose}
        onClose={close}
        testID="goal-retry-time-sheet"
      />
    );
  return { retry, pendingTaskId: pendingRetryTaskId, sheet };
}

/**
 * Asks how a retry restarts a goal's time limit once it has passed: fresh or remaining.
 * `remainingMs` is what remaining would leave, null when unknown. Mount only while open.
 */
export function GoalRetryTimeSheet({
  remainingMs,
  isSending,
  error,
  onChoose,
  onClose,
  testID,
}: {
  remainingMs: number | null;
  isSending: boolean;
  error: string | null;
  onChoose: (timeMode: GoalTimeMode) => void;
  onClose: () => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const noneLeft = remainingMs !== null && remainingMs <= 0;
  const chooseFresh = useCallback(() => onChoose("fresh"), [onChoose]);
  const chooseRemaining = useCallback(() => onChoose("remaining"), [onChoose]);
  const header = useMemo<SheetHeader>(() => ({ title: t("goals.detail.retryTimeTitle") }), [t]);
  const remainingLabel =
    remainingMs !== null && remainingMs > 0
      ? t("goals.detail.retryTimeRemainingLeft", {
          time: formatDuration(
            Math.max(MINUTE_MS, Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS),
          ),
        })
      : t("goals.detail.retryTimeRemaining");
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="outline"
          onPress={chooseRemaining}
          disabled={isSending || noneLeft}
          testID={`${testID}-remaining`}
        >
          {remainingLabel}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={chooseFresh}
          disabled={isSending}
          loading={isSending}
          testID={`${testID}-fresh`}
        >
          {t("goals.detail.retryTimeFresh")}
        </Button>
      </View>
    ),
    [chooseFresh, chooseRemaining, isSending, noneLeft, onClose, remainingLabel, t, testID],
  );

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} footer={footer} testID={testID}>
      <Text style={styles.message}>{t("goals.detail.retryTimeMessage")}</Text>
      {noneLeft ? <Text style={styles.hint}>{t("goals.detail.retryTimeNoneLeft")}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
