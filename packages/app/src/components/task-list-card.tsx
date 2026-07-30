import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { Check, ChevronDown, ChevronRight, Square } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { TodoEntry } from "@/types/stream";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";

const ThemedCheck = withUnistyles(Check);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSquare = withUnistyles(Square);

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
}

const TASK_LIST_MAX_HEIGHT = 144;

export const TaskListCard = memo(function TaskListCard({ items }: TaskListCardProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const headerLabel = useMemo(() => {
    const completedCount = items.filter((item) => item.completed).length;
    if (items.length === 0) return "";
    if (completedCount === items.length) return `${items.length} tasks done`;
    if (completedCount === 0) return `${items.length} tasks`;
    return `${completedCount}/${items.length} tasks done`;
  }, [items]);

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

  if (items.length === 0) {
    return null;
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

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
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
}));
