import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ExternalLink, RotateCcw } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalEvent, Task } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { isGoalTerminal } from "@/goals/goal-derivation";
import {
  buildTaskTimeline,
  formatCompactCount,
  taskTokens,
  type TaskTimelineBar,
} from "@/goals/goal-progress";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import {
  groupGoalTasks,
  latestTaskAgent,
  latestTaskThinking,
  type GoalAgentTarget,
} from "@/goals/goal-tasks";
import { taskGuidance } from "@/goals/goal-recovery";
import { settingsStyles } from "@/styles/settings";
import { useRelativeTimeTick } from "@/usage/use-relative-time-tick";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { toErrorMessage } from "@/utils/error-messages";
import { formatDuration } from "@/utils/time";
import { GoalBar, type GoalBarSegment } from "./goal-bar";
import { useRetryTimeChoice } from "./goal-retry-time-sheet";
import { TaskStatusIcon } from "./task-status-icon";

export function GoalTaskList({
  serverId,
  goal,
  events,
  canRetryTasks,
}: {
  serverId: string;
  goal: Goal;
  events?: readonly GoalEvent[];
  canRetryTasks: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const retryChoice = useRetryTimeChoice({ serverId, goal, events });
  const retryWithChoice = retryChoice.retry;
  const [retryError, setRetryError] = useState<string | null>(null);
  const handleRetry = useCallback(
    (taskId: string) => {
      setRetryError(null);
      retryWithChoice(taskId).catch((error: unknown) => setRetryError(toErrorMessage(error)));
    },
    [retryWithChoice],
  );
  const now = useRelativeTimeTick({ enabled: !isGoalTerminal(goal.status) });
  const groups = useMemo(() => groupGoalTasks(goal), [goal]);
  const bars = useMemo(
    () => new Map(buildTaskTimeline(goal, now).map((bar) => [bar.taskId, bar])),
    [goal, now],
  );

  if (groups.length === 0) {
    return (
      <SettingsSection title={t("goals.detail.tasks")}>
        <SettingsCard>
          <View style={settingsStyles.row}>
            <Text style={styles.muted}>{t("goals.detail.noTasks")}</Text>
          </View>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      {groups.map((group) => (
        <SettingsSection
          key={group.id}
          title={`${t(`goals.detail.taskGroups.${group.id}`)} · ${group.tasks.length}`}
          testID={`goal-task-group-${group.id}`}
        >
          <SettingsCard>
            {group.tasks.map((task) => (
              <TaskRow
                key={task.id}
                serverId={serverId}
                goal={goal}
                task={task}
                bar={bars.get(task.id) ?? null}
                onRetry={canRetryTasks && isRetryable(task) ? handleRetry : null}
                isRetrying={retryChoice.pendingTaskId === task.id}
              />
            ))}
          </SettingsCard>
          {group.id === "attention" && retryError ? (
            <Text style={styles.error}>{retryError}</Text>
          ) : null}
        </SettingsSection>
      ))}
      {retryChoice.sheet}
    </>
  );
}

/** Time a task's change sets spent in one stage, or null when the host recorded none. */
function stageTotalMs(bar: TaskTimelineBar | null, kind: "review" | "merge"): number | null {
  const stages = bar?.stages.filter((stage) => stage.kind === kind) ?? [];
  return stages.length === 0 ? null : stages.reduce((sum, stage) => sum + stage.durationMs, 0);
}

function stageSegments(bar: TaskTimelineBar): GoalBarSegment[] {
  return bar.stages.map((stage, index) => ({
    key: `${stage.kind}-${index}`,
    kind: stage.kind,
    offset: stage.offset,
    fraction: stage.width,
  }));
}

function isRetryable(task: Task): boolean {
  return task.status === "failed" || task.status === "cancelled";
}

function TaskRow({
  serverId,
  goal,
  task,
  bar,
  onRetry,
  isRetrying,
}: {
  serverId: string;
  goal: Goal;
  task: Task;
  bar: TaskTimelineBar | null;
  onRetry: ((taskId: string) => void) | null;
  isRetrying: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const agent = latestTaskAgent(goal, task.id);
  const tokens = taskTokens(goal, task.id);
  const meta = [t(`goals.taskKind.${task.kind}`)];
  if (bar?.durationMs != null) {
    meta.push(formatDuration(bar.durationMs));
  }
  if (task.attempts > 1) {
    meta.push(t("goals.detail.attempts", { n: task.attempts }));
  }
  const reviewMs = stageTotalMs(bar, "review");
  if (reviewMs !== null) {
    meta.push(t("goals.detail.reviewTime", { time: formatDuration(reviewMs) }));
  }
  const mergeMs = stageTotalMs(bar, "merge");
  if (mergeMs !== null) {
    meta.push(t("goals.detail.mergeTime", { time: formatDuration(mergeMs) }));
  }
  if (task.rework) {
    meta.push(t("goals.detail.rework", { n: task.rework.round }));
  }
  if (tokens !== null) {
    meta.push(t("goals.detail.tokens", { n: formatCompactCount(tokens) }));
  }
  const thinking = latestTaskThinking(goal, task.id);
  if (thinking) {
    meta.push(t("goals.detail.thinking", { level: formatThinkingOptionLabel({ id: thinking }) }));
  }
  if (task.dependsOn.length > 0) {
    meta.push(t("goals.detail.dependsOn", { ids: task.dependsOn.join(", ") }));
  }

  return (
    <View style={settingsStyles.row} testID={`goal-task-${task.id}`}>
      <View style={styles.icon}>
        <TaskStatusIcon status={task.status} />
      </View>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{task.title}</Text>
        <Text style={settingsStyles.rowHint}>{meta.join(" · ")}</Text>
        {task.error ? (
          <Text style={settingsStyles.rowError} numberOfLines={3}>
            {task.error}
          </Text>
        ) : null}
        <TaskGuidanceLines goal={goal} taskId={task.id} />
        {bar && (bar.width > 0 || bar.stages.length > 0) ? (
          <View style={styles.timeline}>
            <GoalBar
              fraction={bar.width}
              offset={bar.offset}
              tone={task.status === "failed" ? "danger" : "neutral"}
              segments={stageSegments(bar)}
            />
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        {onRetry ? (
          <RetryTaskButton taskId={task.id} onRetry={onRetry} isRetrying={isRetrying} />
        ) : null}
        {agent ? <OpenAgentButton serverId={serverId} agent={agent} taskId={task.id} /> : null}
      </View>
    </View>
  );
}

/** Your instruction for this task's workers, and the advice a recovery's Lead left for them. */
function TaskGuidanceLines({ goal, taskId }: { goal: Goal; taskId: string }): ReactElement | null {
  const { t } = useTranslation();
  const guidance = taskGuidance(goal, taskId);
  if (!guidance) {
    return null;
  }
  return (
    <>
      {/* Ahead of the text, so the line limit below never hides it. */}
      {guidance.personCut ? (
        <Text style={settingsStyles.rowHint} testID={`goal-task-${taskId}-guidance-cut`}>
          {t("goals.detail.guidanceTruncated")}
        </Text>
      ) : null}
      {guidance.person ? (
        <Text
          style={settingsStyles.rowHint}
          numberOfLines={2}
          testID={`goal-task-${taskId}-guidance`}
        >
          {t("goals.detail.yourInstruction", { text: guidance.person })}
        </Text>
      ) : null}
      {guidance.lead ? (
        <Text
          style={settingsStyles.rowHint}
          numberOfLines={2}
          testID={`goal-task-${taskId}-lead-advice`}
        >
          {t("goals.detail.leadAdvice", { text: guidance.lead })}
        </Text>
      ) : null}
    </>
  );
}

function RetryTaskButton({
  taskId,
  onRetry,
  isRetrying,
}: {
  taskId: string;
  onRetry: (taskId: string) => void;
  isRetrying: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onRetry(taskId), [onRetry, taskId]);
  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={RotateCcw}
      onPress={handlePress}
      loading={isRetrying}
      testID={`goal-retry-task-${taskId}`}
    >
      {t("goals.detail.retryTask")}
    </Button>
  );
}

export function OpenAgentButton({
  serverId,
  agent,
  taskId,
  label,
}: {
  serverId: string;
  agent: GoalAgentTarget;
  taskId: string;
  label?: string;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    navigateToAgent({ serverId, agentId: agent.agentId, workspaceId: agent.workspaceId });
  }, [agent.agentId, agent.workspaceId, serverId]);
  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={ExternalLink}
      onPress={handlePress}
      testID={`goal-open-agent-${taskId}`}
    >
      {label ?? t("goals.detail.openAgent")}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  icon: {
    alignSelf: "flex-start",
    marginRight: theme.spacing[3],
    paddingTop: 1,
  },
  timeline: {
    marginTop: theme.spacing[2],
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
