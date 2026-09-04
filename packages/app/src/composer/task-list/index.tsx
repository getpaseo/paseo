import { memo, useCallback, useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { ComposerTrackProgressRing } from "@/composer/track-progress-ring";
import { TaskListRow } from "@/components/task-list-row";
import { selectAgentTasksAreLive, useSessionStore } from "@/stores/session-store";
import type { TodoEntry } from "@/types/stream";

export const AgentTaskList = memo(function AgentTaskList({
  serverId,
  agentId,
  tasks,
}: {
  serverId: string;
  agentId: string;
  tasks: TodoEntry[] | undefined;
}) {
  if (!tasks?.length) return null;
  return <TaskListCard serverId={serverId} agentId={agentId} tasks={tasks} />;
});

const TaskListCard = memo(function TaskListCard({
  serverId,
  agentId,
  tasks,
}: {
  serverId: string;
  agentId: string;
  tasks: TodoEntry[];
}) {
  const { t } = useTranslation();
  const completed = useMemo(
    () => tasks.filter((task) => task.completed || task.status === "completed").length,
    [tasks],
  );
  // Counts only. The active task used to ride along in the header, where it was the first thing
  // truncated on a phone; the panel shows it in full, in place, with the rest of the list.
  const label = t("message.todo.tasksProgress", { completed, total: tasks.length });
  const segments = useMemo(() => [{ bucket: null, text: label }], [label]);
  // The same fraction the label spells, as the mark that leads it. The ring is the part you can
  // read at a glance without parsing two numbers, and the numbers stay for the exact count.
  const progress = completed / tasks.length;
  // The snapshot outlives the turn that wrote it: nothing clears `agentTasks` when an agent stops,
  // so a turn that ends while a task is still in progress leaves that row on screen. The store
  // says whether the list belongs to the turn running now; the row's own status cannot.
  const isLive = useSessionStore((state) =>
    selectAgentTasksAreLive(state.sessions[serverId], agentId),
  );
  const renderMark = useCallback(
    () => <ComposerTrackProgressRing progress={progress} />,
    [progress],
  );

  return (
    <ComposerTrackPill
      testID="agent-task-list-header"
      segments={segments}
      leading={renderMark}
      panelTitle={t("message.todo.title")}
    >
      {tasks.map((task, index) => (
        <ComposerTrackRow key={task.id ?? `${index}:${task.text}`}>
          <View style={styles.taskRow}>
            <TaskListRow task={task} live={isLive} />
          </View>
        </ComposerTrackRow>
      ))}
    </ComposerTrackPill>
  );
});

const styles = StyleSheet.create(() => ({
  // The task row draws its own icon and text; this only lets it span the shared row frame.
  // Basis stays `auto` so the text's width reaches the panel's measurement — see track.tsx.
  taskRow: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
  },
}));
