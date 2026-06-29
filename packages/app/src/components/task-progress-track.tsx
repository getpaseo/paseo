import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, ListTodo } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskProgressPayload } from "@getpaseo/protocol/messages";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedListTodo = withUnistyles(ListTodo);
const ThemedCheck = withUnistyles(Check);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryForegroundColorMapping = (theme: Theme) => ({
  color: theme.colors.primaryForeground,
});

export interface TaskProgressTrackProps {
  taskProgress: TaskProgressPayload;
}

const LIST_MAX_HEIGHT = 200;

/**
 * A persistent, collapsible task-progress bar shown above the composer. Unlike
 * the inline TodoListCard (which scrolls away with the message stream), this
 * stays pinned so the user can always see overall task progress. Mirrors the
 * SubagentsTrack surface styling so the two read as a coherent stack.
 */
export function TaskProgressTrack({ taskProgress }: TaskProgressTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.header,
      expanded ? styles.headerDivider : styles.headerCollapsed,
      (hovered || pressed) && styles.headerActive,
    ],
    [expanded],
  );

  // Task text can repeat across rows, so suffix duplicates with an occurrence
  // count to keep keys stable and content-derived (no array index).
  const keyedTaskItems = useMemo(() => {
    const seen = new Map<string, number>();
    return taskProgress.items.map((item) => {
      const occurrence = seen.get(item.text) ?? 0;
      seen.set(item.text, occurrence + 1);
      return { ...item, key: `${item.text}#${occurrence}` };
    });
  }, [taskProgress.items]);

  const { total, completed } = taskProgress;
  if (total === 0) {
    return null;
  }

  const ratio = Math.max(0, Math.min(1, completed / total));
  const nextTask = taskProgress.items.find((item) => item.status !== "completed")?.text;
  const headerLabel = t("taskProgress.progress", { completed, total });

  return (
    <View style={styles.outer} testID="task-progress-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={headerLabel}
            testID="task-progress-track-header"
            onPress={toggleExpanded}
            style={headerStyle}
          >
            {expanded ? (
              <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
            ) : (
              <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
            )}
            <ThemedListTodo size={12} uniProps={foregroundMutedColorMapping} />
            <Text style={styles.headerLabel} numberOfLines={1}>
              {headerLabel}
            </Text>
            {!expanded && nextTask ? (
              <Text style={styles.headerSecondary} numberOfLines={1}>
                {nextTask}
              </Text>
            ) : null}
            <View style={styles.progressTrack}>
              <ProgressFill ratio={ratio} />
            </View>
          </Pressable>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {keyedTaskItems.map((item) => (
                <TaskProgressRow key={item.key} text={item.text} status={item.status} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function ProgressFill({ ratio }: { ratio: number }): ReactElement {
  const fillStyle = useMemo(
    () => [styles.progressFill, { width: `${ratio * 100}%` as const }],
    [ratio],
  );
  return <View style={fillStyle} />;
}

function getBadgeStatusStyle(
  status: TaskProgressPayload["items"][number]["status"],
): typeof styles.radioBadgeComplete {
  if (status === "completed") {
    return styles.radioBadgeComplete;
  }
  if (status === "in_progress") {
    return styles.radioBadgeInProgress;
  }
  return styles.radioBadgeIncomplete;
}

function TaskProgressRow({
  text,
  status,
}: {
  text: string;
  status: TaskProgressPayload["items"][number]["status"];
}): ReactElement {
  const completed = status === "completed";
  const badgeStyle = useMemo(() => [styles.radioBadge, getBadgeStatusStyle(status)], [status]);
  const textStyle = useMemo(
    () => [styles.itemText, completed && styles.itemTextCompleted],
    [completed],
  );
  return (
    <View style={styles.itemRow}>
      <View style={badgeStyle}>
        {completed ? <ThemedCheck size={12} uniProps={primaryForegroundColorMapping} /> : null}
      </View>
      <Text style={textStyle} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    marginBottom: -theme.spacing[4],
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderBottomWidth: 0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[6],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  headerSecondary: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  progressTrack: {
    width: 56,
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    marginLeft: "auto",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  scroll: {
    maxHeight: LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  radioBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  radioBadgeIncomplete: {
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.45,
  },
  radioBadgeInProgress: {
    backgroundColor: theme.colors.palette.blue[500],
    opacity: 0.9,
  },
  radioBadgeComplete: {
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.95,
  },
  itemText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
    textDecorationLine: "line-through",
  },
}));
