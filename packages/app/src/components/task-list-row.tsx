import { Check } from "lucide-react-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import {
  buildTaskRowPresentation,
  type TaskRowMark,
} from "@/components/task-list-row-presentation";
import { STATUS_RING_FRAME_SIZE } from "@/components/status-ring/geometry";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";

const ThemedCheck = withUnistyles(Check);

const completedIcon = (theme: Theme) => ({ color: theme.colors.statusSuccess });

/**
 * The three marks the rest of the app already draws for these states: a dot waiting, the running
 * ring in progress, a check done. Not outline circles — a hollow circle beside a check reads as a
 * checkbox, and a task list mirrors what the agent decided, read-only.
 *
 * The ring only turns on `live` rows. Transcript task cards are snapshots of a past write, and a
 * turning ring there claims activity for a frozen list. It takes no backdrop: the mark has a slot
 * of its own rather than overlapping an icon, so there is nothing to knock out behind it.
 */
function TaskStatusMark({ mark, live }: { mark: TaskRowMark; live: boolean }) {
  return (
    <View style={styles.mark}>
      <TaskStatusGlyph mark={mark} live={live} />
    </View>
  );
}

function TaskStatusGlyph({ mark, live }: { mark: TaskRowMark; live: boolean }) {
  if (mark === "done") {
    return <ThemedCheck size={STATUS_RING_FRAME_SIZE} uniProps={completedIcon} />;
  }
  if (mark === "running" && live) {
    return <StatusRing />;
  }
  return <View style={[styles.dot, mark === "running" && styles.dotRunning]} />;
}

export const TaskListRow = memo(function TaskListRow({
  task,
  live = false,
}: {
  task: TodoEntry;
  /** True where the row reflects the agent's current list rather than a past snapshot. */
  live?: boolean;
}) {
  const { mark, text } = buildTaskRowPresentation(task);

  return (
    <View style={styles.row} accessibilityLabel={text}>
      <TaskStatusMark mark={mark} live={live} />
      <Text
        numberOfLines={1}
        style={[
          styles.text,
          mark === "running" && styles.runningText,
          mark === "done" && styles.completedText,
        ]}
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
  // One slot for all three marks, sized to the widest of them, so the text column holds still as
  // a task advances from waiting to running to done.
  mark: {
    width: STATUS_RING_FRAME_SIZE,
    height: STATUS_RING_FRAME_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  // The running ring's centre, on its own. Same size and same colour, so a snapshot row and a
  // live row differ by the motion and by nothing else.
  dotRunning: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  // Grows and shrinks, but keeps an `auto` basis: a zero-basis label reports no intrinsic width,
  // and a container that sizes itself to its content — the composer track panel — measures the
  // row as empty and truncates it against a surface that had room to spare.
  text: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  runningText: {
    color: theme.colors.foreground,
  },
  completedText: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
}));
