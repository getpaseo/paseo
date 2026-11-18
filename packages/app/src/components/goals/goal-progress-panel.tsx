import type { ReactElement, ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { isGoalTerminal } from "@/goals/goal-derivation";
import { estimateLabel } from "@/goals/goal-labels";
import {
  buildVerificationBar,
  countGoalTasks,
  estimateRemaining,
  goalDeadline,
  goalElapsedMs,
  goalPercent,
} from "@/goals/goal-progress";
import { settingsStyles } from "@/styles/settings";
import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { formatDuration } from "@/utils/time";
import { GoalBar, type GoalBarTone } from "./goal-bar";

const WARN_FRACTION = 0.8;
const MINUTE_MS = 60_000;

/** The panel ticks once a minute, so past the first minute it shows whole minutes only. */
function formatMinutes(ms: number): string {
  return formatDuration(ms < MINUTE_MS ? ms : Math.floor(ms / MINUTE_MS) * MINUTE_MS);
}

export function fractionTone(fraction: number, isOver: boolean): GoalBarTone {
  if (isOver) {
    return "danger";
  }
  return fraction >= WARN_FRACTION ? "warning" : "neutral";
}

/**
 * Percent, counts and time for a managed goal, refreshed by polling and a minute tick. Tokens and
 * cost are in `GoalUsageSection`.
 */
export function GoalProgressPanel({ goal }: { goal: Goal }): ReactElement {
  const { t } = useTranslation();
  const isLive = !isGoalTerminal(goal.status);
  const now = useRelativeTimeTick({ enabled: isLive });
  const percent = goalPercent(goal);
  const counts = countGoalTasks(goal);
  const elapsedMs = goalElapsedMs(goal, now);
  const estimate = estimateLabel(t, estimateRemaining(goal, now));
  const deadline = goalDeadline(goal, now);
  const verification = buildVerificationBar(goal, now);

  let deadlineValue: string | null = null;
  if (deadline.kind === "running") {
    deadlineValue = t("goals.progress.deadlineLeft", {
      time: formatMinutes(deadline.remainingMs),
    });
  } else if (deadline.kind === "overdue") {
    deadlineValue = t("goals.progress.deadlineOverdue", {
      time: formatMinutes(deadline.overdueMs),
    });
  }

  return (
    <SettingsSection title={t("goals.progress.title")}>
      <SettingsCard testID="goal-progress">
        <View style={settingsStyles.row}>
          <View style={styles.fill}>
            <View style={styles.headline}>
              <Text style={settingsStyles.rowTitle}>
                {t("goals.progress.percent", { percent })}
              </Text>
              {counts.failed > 0 ? (
                <Text style={styles.danger}>
                  {t("goals.progress.failed", { n: counts.failed })}
                </Text>
              ) : null}
            </View>
            <GoalBar fraction={percent / 100} tone={percent === 100 ? "success" : "neutral"} />
            <Text style={settingsStyles.rowHint}>
              {t("goals.progress.counts", {
                done: counts.done,
                running: counts.running,
                remaining: counts.remaining,
              })}
            </Text>
          </View>
        </View>
        <MetricRow label={t("goals.progress.elapsed")} value={formatMinutes(elapsedMs)} />
        {estimate ? (
          <MetricRow
            label={t("goals.progress.remaining")}
            value={estimate}
            testID="goal-progress-estimate"
          />
        ) : null}
        {deadlineValue && deadline.kind !== "none" ? (
          <MetricRow label={t("goals.progress.deadline")} value={deadlineValue}>
            <GoalBar
              fraction={deadline.kind === "running" ? deadline.usedFraction : 1}
              tone={fractionTone(
                deadline.kind === "running" ? deadline.usedFraction : 1,
                deadline.kind === "overdue",
              )}
            />
          </MetricRow>
        ) : null}
        {verification ? (
          <MetricRow
            label={t("goals.progress.verification")}
            value={
              verification.isRunning
                ? t("goals.progress.verificationRunning", {
                    time: formatMinutes(verification.durationMs),
                  })
                : formatDuration(verification.durationMs)
            }
            testID="goal-progress-verification"
          >
            <GoalBar
              fraction={verification.width}
              offset={verification.offset}
              tone={goal.verifiedAt ? "success" : "neutral"}
            />
          </MetricRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function MetricRow({
  label,
  value,
  hint,
  children,
  testID,
}: {
  label: string;
  value: string;
  /** Muted lines under the bar, one per entry. */
  hint?: readonly string[];
  children?: ReactNode;
  testID?: string;
}): ReactElement {
  return (
    <View style={settingsStyles.row} testID={testID}>
      <View style={styles.fill}>
        <View style={styles.headline}>
          <Text style={styles.metricLabel}>{label}</Text>
          <Text style={settingsStyles.rowTitle}>{value}</Text>
        </View>
        {children}
        {hint?.map((line) => (
          <Text key={line} style={styles.hint}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
    gap: theme.spacing[2],
  },
  headline: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  metricLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  danger: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
