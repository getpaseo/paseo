import { Circle, CircleCheck, CircleDot } from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const ThemedCircle = withUnistyles(Circle);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);

const extraMutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const runningIcon = (theme: Theme) => ({ color: theme.colors.statusDotRunning });

function TaskStatusIcon({ isCompleted, isRunning }: { isCompleted: boolean; isRunning: boolean }) {
  if (isCompleted) {
    return <ThemedCircleCheck size={16} uniProps={extraMutedIcon} />;
  }
  if (isRunning) {
    return <ThemedCircleDot size={16} uniProps={runningIcon} />;
  }
  return <ThemedCircle size={16} uniProps={mutedIcon} />;
}

export const TaskListRow = memo(function TaskListRow({ task }: { task: TodoEntry }) {
  const isCompleted = task.completed || task.status === "completed";
  const isRunning = !isCompleted && task.status === "in_progress";
  const text = isRunning && task.activeForm ? task.activeForm : task.text;

  return (
    <View style={styles.row} accessibilityLabel={text}>
      <TaskStatusIcon isCompleted={isCompleted} isRunning={isRunning} />
      <Text
        numberOfLines={1}
        style={[styles.text, isRunning && styles.runningText, isCompleted && styles.completedText]}
      >
        {text}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  runningText: {
    color: theme.colors.foreground,
  },
  completedText: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
}));
