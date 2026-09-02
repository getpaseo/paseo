import type { PluginTimelineItemProps } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { piTaskListSchema } from "../shared/pi-tasks";

type TaskListData = z.output<typeof piTaskListSchema>;

const taskMarker = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
} as const;

export function PiTaskList({ item, theme }: PluginTimelineItemProps<TaskListData>) {
  const completed = item.data.tasks.filter((task) => task.status === "completed").length;
  const styles = useMemo(
    () => ({
      card: {
        gap: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: 12,
        backgroundColor: theme.colors.surface1,
      },
      header: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      progress: { color: theme.colors.foregroundMuted },
      task: { flexDirection: "row" as const, gap: 8 },
      completed: { color: theme.colors.statusSuccess },
      inProgress: { color: theme.colors.accent },
      pending: { color: theme.colors.foregroundMuted },
      taskText: { color: theme.colors.foreground, flex: 1 },
      completedText: { color: theme.colors.foregroundMuted, flex: 1 },
    }),
    [theme],
  );

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>Pi tasks</Text>
        <Text style={styles.progress}>
          {completed}/{item.data.tasks.length}
        </Text>
      </View>
      {item.data.tasks.map((task) => {
        let markerStyle = styles.pending;
        if (task.status === "completed") markerStyle = styles.completed;
        if (task.status === "in_progress") markerStyle = styles.inProgress;
        return (
          <View key={task.text} style={styles.task}>
            <Text style={markerStyle}>{taskMarker[task.status]}</Text>
            <Text style={task.status === "completed" ? styles.completedText : styles.taskText}>
              {task.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
