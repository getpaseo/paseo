import { useEffect, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { SquareTerminal } from "lucide-react-native";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useSessionStore } from "@/stores/session-store";
import {
  backgroundTaskKey,
  refreshBackgroundTasks,
  useBackgroundTaskStore,
} from "@/background-tasks/store";
import { useBackgroundTaskOutput } from "@/background-tasks/use-background-task-output";

function useBackgroundTaskPanelDescriptor(
  target: { kind: "background_task"; parentAgentId: string; taskId: string },
  context: { serverId: string },
): PanelDescriptor {
  const task = useBackgroundTaskStore((state) =>
    state.tasks.get(backgroundTaskKey(context.serverId, target.parentAgentId, target.taskId)),
  );
  const label = task?.command?.trim() || task?.description?.trim() || target.taskId;
  return {
    label,
    subtitle: "Background task",
    tooltip: label,
    titleState: task ? "ready" : "loading",
    icon: SquareTerminal,
    statusBucket: task?.status === "running" ? "running" : null,
  };
}

function BackgroundTaskPanel() {
  const { t } = useTranslation();
  const { serverId, target } = usePaneContext();
  const { isPaneFocused } = usePaneFocus();
  invariant(
    target.kind === "background_task",
    "BackgroundTaskPanel requires background_task target",
  );
  const key = backgroundTaskKey(serverId, target.parentAgentId, target.taskId);
  const task = useBackgroundTaskStore((state) => state.tasks.get(key) ?? null);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  // COMPAT(backgroundTasks): added in v0.2.x, remove after 2027-02-01.
  const supported = serverInfo?.features?.backgroundTasks === true;

  useEffect(() => {
    if (!client || !supported) return;
    void refreshBackgroundTasks(client, serverId, target.parentAgentId).catch(() => undefined);
  }, [client, serverId, supported, target.parentAgentId]);

  const { text, error, loading } = useBackgroundTaskOutput({
    serverId,
    parentAgentId: target.parentAgentId,
    taskId: target.taskId,
    supported,
    isPaneFocused,
  });

  const command = task?.command?.trim() || task?.description?.trim() || target.taskId;
  const status = task?.status ?? "unknown";
  const body = useMemo(() => {
    if (text.trim().length > 0) return text;
    if (loading) return t("common.states.loading");
    if (error) return error;
    return t("backgroundTasks.noLiveLog");
  }, [error, loading, t, text]);

  return (
    <View style={styles.root} testID="background-task-panel">
      <View style={styles.header}>
        <Text style={styles.command} numberOfLines={2}>
          {command}
        </Text>
        <Text style={styles.meta}>{status}</Text>
        {task?.description ? (
          <Text style={styles.description} numberOfLines={3}>
            {task.description}
          </Text>
        ) : null}
      </View>
      <ScrollView style={styles.logScroll} contentContainerStyle={styles.logContent}>
        <Text style={styles.logText} selectable>
          {body}
        </Text>
      </ScrollView>
    </View>
  );
}

export const backgroundTaskPanelRegistration: PanelRegistration<"background_task"> = {
  kind: "background_task",
  component: BackgroundTaskPanel,
  useDescriptor: useBackgroundTaskPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  command: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  logScroll: {
    flex: 1,
  },
  logContent: {
    padding: theme.spacing[4],
  },
  logText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
}));
