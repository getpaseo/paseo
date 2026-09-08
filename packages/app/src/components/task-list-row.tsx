import { Circle, CircleAlert, CircleCheck, CircleDot, CircleX } from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { taskStatus, type TodoEntry } from "@/types/stream";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleX = withUnistyles(CircleX);

const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const runningIcon = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const blockedIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });

function TaskStatusIcon({ state }: { state: NonNullable<TodoEntry["state"]> }) {
  if (state === "completed") {
    return <ThemedCircleCheck size={16} uniProps={extraMutedIcon} />;
  }
  if (state === "abandoned") {
    return <ThemedCircleX size={16} uniProps={extraMutedIcon} />;
  }
  if (state === "blocked") {
    return <ThemedCircleAlert size={16} uniProps={blockedIcon} />;
  }
  if (state === "in_progress") {
    return <ThemedCircleDot size={16} uniProps={runningIcon} />;
  }
  // A pending task's ring is a status mark, not a checkbox. At the muted step it carries the
  // weight of an enabled control and invites a click that does nothing, so it sits one step back
  // from the text it marks.
  return <ThemedCircle size={16} uniProps={extraMutedIcon} />;
}

export const TaskListRow = memo(function TaskListRow({
  task,
  previousTask,
}: {
  task: TodoEntry;
  previousTask?: TodoEntry;
}) {
  const { t } = useTranslation();
  const state = taskStatus(task);
  const isTerminal = state === "completed" || state === "abandoned";
  const isRunning = state === "in_progress";
  const text = isRunning && task.activeForm ? task.activeForm : task.text;
  const phaseChanged =
    task.phase !== previousTask?.phase || task.phaseIndex !== previousTask?.phaseIndex;
  const showPhase = task.phase !== undefined && phaseChanged;
  let stateLabel: string | undefined;
  if (state === "blocked" || state === "abandoned") {
    stateLabel = t(`message.todo.activity.${state}`);
  }
  const accessibilityLabel = [task.phase, text, stateLabel, task.blocker]
    .filter(Boolean)
    .join(". ");

  return (
    <View style={styles.item}>
      {showPhase ? (
        <Text accessibilityRole="header" style={styles.phase}>
          {task.phase}
        </Text>
      ) : null}
      <View style={styles.row} accessibilityLabel={accessibilityLabel}>
        <TaskStatusIcon state={state} />
        <View style={styles.content}>
          <Text
            numberOfLines={1}
            style={[
              styles.text,
              isRunning && styles.runningText,
              isTerminal && styles.completedText,
            ]}
          >
            {text}
          </Text>
          {stateLabel ? (
            <Text style={[styles.detail, state === "blocked" && styles.blockedText]}>
              {stateLabel}
            </Text>
          ) : null}
          {task.blocker !== undefined ? <Text style={styles.detail}>{task.blocker}</Text> : null}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  item: {
    gap: theme.spacing[1],
  },
  phase: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  // Grows and shrinks, but keeps an `auto` basis: a zero-basis label reports no intrinsic width,
  // and a container that sizes itself to its content — the composer track panel — measures the
  // row as empty and truncates it against a surface that had room to spare.
  content: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  runningText: {
    color: theme.colors.foreground,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  blockedText: {
    color: theme.colors.statusWarning,
  },
  completedText: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
}));
