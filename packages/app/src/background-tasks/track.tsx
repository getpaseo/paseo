import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentBackgroundTaskPayload } from "@getpaseo/protocol/messages";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import {
  buildBackgroundTasksPillPresentation,
  resolveBackgroundTaskKind,
  type BackgroundTaskKind,
  type BackgroundTasksPillPresentation,
} from "./presentation";
import type { StopBackgroundTaskRequest } from "./use-stop-background-task";

const ThemedSquare = withUnistyles(Square);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const STOP_ICON_SIZE = 12;

/**
 * Shells and monitors the agent left running when its turn ended — what the Claude Code footer
 * counts as "1 shell". The agent wakes on its own when they finish, so the pill carries the
 * running ring, the same mark the sidebar shows for the agent meanwhile.
 */
export function BackgroundTasksTrack({
  tasks,
  onStopTask,
}: {
  tasks: readonly AgentBackgroundTaskPayload[];
  /** Absent when the host cannot stop a single task. */
  onStopTask?: (request: StopBackgroundTaskRequest) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const pill = useMemo(() => buildBackgroundTasksPillPresentation(tasks), [tasks]);
  const label = t(resolvePillLabelKey(pill), { count: pill.count });
  const segments = useMemo(() => [{ bucket: "running" as const, text: label }], [label]);

  if (tasks.length === 0) {
    return null;
  }

  return (
    <ComposerTrackPill
      testID="background-tasks-track"
      segments={segments}
      panelTitle={t("backgroundTasks.title")}
    >
      {tasks.map((task) => (
        <BackgroundTaskRow key={task.id} task={task} onStopTask={onStopTask} />
      ))}
    </ComposerTrackPill>
  );
}

type PillLabelKey =
  | "backgroundTasks.pillShellsOne"
  | "backgroundTasks.pillShellsMany"
  | "backgroundTasks.pillTasksOne"
  | "backgroundTasks.pillTasksMany";

function resolvePillLabelKey(pill: BackgroundTasksPillPresentation): PillLabelKey {
  if (pill.noun === "shell") {
    return pill.count === 1 ? "backgroundTasks.pillShellsOne" : "backgroundTasks.pillShellsMany";
  }
  return pill.count === 1 ? "backgroundTasks.pillTasksOne" : "backgroundTasks.pillTasksMany";
}

function useKindLabel(kind: BackgroundTaskKind, type: string): string {
  const { t } = useTranslation();
  switch (kind) {
    case "shell":
      return t("backgroundTasks.kindShell");
    case "monitor":
      return t("backgroundTasks.kindMonitor");
    case "other":
      return type;
  }
}

function BackgroundTaskRow({
  task,
  onStopTask,
}: {
  task: AgentBackgroundTaskPayload;
  onStopTask?: (request: StopBackgroundTaskRequest) => void;
}): ReactElement {
  const { t } = useTranslation();
  const kindLabel = useKindLabel(resolveBackgroundTaskKind(task.type), task.type);
  const label = task.description ?? kindLabel;
  const handleStop = useCallback(() => {
    onStopTask?.({ taskId: task.id, label });
  }, [label, onStopTask, task.id]);

  return (
    <ComposerTrackRow accessibilityLabel={label}>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      {task.description ? (
        <Text style={styles.rowTrailing} numberOfLines={1}>
          {kindLabel}
        </Text>
      ) : null}
      {onStopTask ? (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("backgroundTasks.stopAction", { label })}
              testID={`background-tasks-track-stop-${task.id}`}
              onPress={handleStop}
              style={styles.actionButton}
              hitSlop={8}
            >
              {({ hovered, pressed }) => (
                <ThemedSquare
                  size={STOP_ICON_SIZE}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{t("backgroundTasks.stopTooltip")}</Text>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </ComposerTrackRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Same rail as the subagents track: the label grows from its content so the panel measures
  // its real width, and the trailing kind gives way first.
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowTrailing: {
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
