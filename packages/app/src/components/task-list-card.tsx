import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { Archive, Check, ChevronDown, ChevronRight, Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ThemedCheck = withUnistyles(Check);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSquare = withUnistyles(Square);
const ThemedArchive = withUnistyles(Archive);

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const completedColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

function TaskCheckbox({ completed }: { completed: boolean }) {
  if (completed) {
    return <ThemedCheck size={16} uniProps={completedColorMapping} />;
  }
  return <ThemedSquare size={16} uniProps={foregroundMutedColorMapping} />;
}

interface TaskListCardProps {
  items: TodoEntry[];
  onDismissCompleted?: () => void;
}

const TASK_LIST_MAX_HEIGHT = 144;

const ArchiveCompletedButton = memo(function ArchiveCompletedButton({
  onPress,
}: {
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("message.todo.archiveCompleted")}
          testID="task-list-archive-completed"
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.todo.archiveCompletedTooltip")}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

export const TaskListCard = memo(function TaskListCard({
  items,
  onDismissCompleted,
}: TaskListCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Track which snapshot was dismissed by its text content hash.
  // When the agent sends a new todo list the fingerprint changes and
  // the card becomes visible again automatically.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const { t } = useTranslation();

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const handleDismissCompleted = useCallback(() => {
    setDismissedKey(items.map((i) => `${i.text}:${i.completed}`).join("|"));
    onDismissCompleted?.();
  }, [items, onDismissCompleted]);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  const headerToggleStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.headerToggle,
      (hovered || pressed) && styles.headerActive,
    ],
    [],
  );

  if (
    dismissedKey === items.map((i) => `${i.text}:${i.completed}`).join("|") ||
    items.length === 0
  ) {
    return null;
  }

  const completedCount = items.filter((item) => item.completed).length;

  let headerLabel: string;
  if (completedCount === items.length) {
    headerLabel = t("message.todo.tasksDoneAll", { count: items.length });
  } else if (completedCount === 0) {
    headerLabel = t("message.todo.tasksRemaining", { count: items.length });
  } else {
    headerLabel = t("message.todo.tasksProgress", {
      completed: completedCount,
      total: items.length,
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              onPress={toggleExpanded}
              style={headerToggleStyle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
            {completedCount === items.length && items.length > 0 ? (
              <View style={styles.headerAction}>
                <ArchiveCompletedButton onPress={handleDismissCompleted} />
              </View>
            ) : null}
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {items.map((item) => (
                <View key={item.text} style={styles.row}>
                  <TaskCheckbox completed={item.completed} />
                  <Text
                    style={[styles.itemText, item.completed && styles.itemTextCompleted]}
                    numberOfLines={1}
                  >
                    {item.text}
                  </Text>
                </View>
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
});

/**
 * Simple timeline rendering of a todo list entry.
 * Shows all tasks with check/box icons — no expand/collapse chrome.
 */
export const TodoListTimeline = memo(function TodoListTimeline({ items }: { items: TodoEntry[] }) {
  return (
    <View style={timelineStyles.list}>
      {items.map((item) => (
        <View key={item.text} style={timelineStyles.row}>
          <TaskCheckbox completed={item.completed} />
          <Text
            style={[timelineStyles.itemText, item.completed && timelineStyles.itemTextCompleted]}
            numberOfLines={1}
          >
            {item.text}
          </Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
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
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[4],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerAction: {
    paddingRight: theme.spacing[2],
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: TASK_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));

const timelineStyles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  itemText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  itemTextCompleted: {
    color: theme.colors.foregroundMuted,
  },
}));
