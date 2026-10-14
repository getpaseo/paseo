import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { WorkspaceTodo } from "@getpaseo/protocol/workspace-todos";
import { Button } from "@/components/ui/button";
import { DraggableList } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import type { TodoMilestone } from "./grouping";

const Down = withUnistyles(ChevronDown);
const Right = withUnistyles(ChevronRight);
const iconColor = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});
const taskKey = (task: WorkspaceTodo) => task.id;
interface Props {
  group: TodoMilestone;
  index: number;
  editingIds: Set<string>;
  extraData: unknown;
  renderTask(info: DraggableRenderItemInfo<WorkspaceTodo>): ReactElement;
  onReorder(tasks: WorkspaceTodo[]): void;
}
export function MilestoneSection({
  group,
  index,
  editingIds,
  extraData,
  renderTask,
  onReorder,
}: Props) {
  const { t } = useTranslation();
  const [disclosed, setDisclosed] = useState<boolean>();
  const [showDone, setShowDone] = useState(false);
  const completed = group.tasks.filter((task) => task.status === "done");
  // Keep edited rows mounted while remote status changes move them to history.
  const active = group.tasks.filter((task) => task.status !== "done" || editingIds.has(task.id));
  const history = completed.filter((task) => !editingIds.has(task.id));
  const editing = group.tasks.some((task) => editingIds.has(task.id));
  const finished = completed.length === group.tasks.length;
  const expanded = editing || (disclosed ?? !finished);
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const historyState = useMemo(() => ({ expanded: showDone }), [showDone]);
  const toggle = useCallback(() => setDisclosed(!expanded), [expanded]);
  const toggleDone = useCallback(() => setShowDone((value) => !value), []);
  return (
    <View style={styles.group} testID={`workspace-todo-milestone-${group.name}`}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={expandedState}
        style={[styles.header, finished && styles.finishedHeader]}
        testID={`workspace-todo-milestone-toggle-${group.name}`}
      >
        <Text style={[styles.number, finished && styles.finishedNumber]}>
          {finished ? "✓" : String(index + 1).padStart(2, "0")}
        </Text>
        <View style={styles.heading}>
          <Text style={styles.title}>{group.name || t("workspaceTodos.ungrouped")}</Text>
          <View style={styles.summary}>
            <Text style={styles.muted}>
              {finished
                ? t("workspaceTodos.milestoneDone")
                : t("workspaceTodos.remaining", { count: group.tasks.length - completed.length })}
            </Text>
            <Text style={styles.muted}>
              {completed.length}/{group.tasks.length}
            </Text>
          </View>
          {!finished && (
            <View style={styles.track}>
              <View style={styles.fill(completed.length / group.tasks.length)} />
            </View>
          )}
        </View>
        {expanded ? (
          <Down size={14} uniProps={iconColor} />
        ) : (
          <Right size={14} uniProps={iconColor} />
        )}
      </Pressable>
      {expanded && (
        <View style={styles.body}>
          <DraggableList
            data={active}
            keyExtractor={taskKey}
            useDragHandle
            scrollEnabled={false}
            extraData={extraData}
            onDragEnd={onReorder}
            renderItem={renderTask}
          />
          {history.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={showDone ? ChevronDown : ChevronRight}
                onPress={toggleDone}
                accessibilityState={historyState}
                testID={`workspace-todo-completed-toggle-${group.name}`}
              >
                {t("workspaceTodos.completed", { count: history.length })}
              </Button>
              {showDone && (
                <DraggableList
                  data={history}
                  keyExtractor={taskKey}
                  useDragHandle
                  scrollEnabled={false}
                  extraData={extraData}
                  onDragEnd={onReorder}
                  renderItem={renderTask}
                />
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  group: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.statusWarningTint,
  },
  finishedHeader: { backgroundColor: theme.colors.statusSuccessTint },
  number: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
    paddingHorizontal: theme.spacing[1],
    paddingTop: theme.spacing[1],
  },
  finishedNumber: { color: theme.colors.statusSuccess },
  heading: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  summary: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  track: {
    height: 3,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    marginTop: theme.spacing[1],
  },
  fill: (progress: number) => ({
    height: "100%",
    width: `${progress * 100}%`,
    backgroundColor: theme.colors.accent,
  }),
  body: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
}));
