import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, ChevronDown, MoreHorizontal, Plus, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";

export type Layout = "original" | "compact" | "steps" | "board" | "detail" | "focus";
interface Task {
  title: string;
  notes: string;
  status: number;
}
const STATES = ["To do", "In progress", "Done"];
const TASKS: Task[] = [
  {
    title: "Define the data model",
    notes: "Stable task IDs, list revision and manual text protection.",
    status: 2,
  },
  {
    title: "Build the workspace panel",
    notes: "Keep the checklist accessible beside Play. Preserve drafts when switching workspaces.",
    status: 1,
  },
  {
    title: "Connect agent tools",
    notes: "Read the shared list before planning and update progress as work advances.",
    status: 0,
  },
  {
    title: "Verify mobile and desktop",
    notes: "Check notes, ordering, conflicts and reconnection on both layouts.",
    status: 0,
  },
];

function TaskRow({
  task,
  index,
  layout,
  onChange,
  onSelect,
}: {
  task: Task;
  index: number;
  layout: Layout;
  onChange(index: number): void;
  onSelect(index: number): void;
}) {
  const [expanded, setExpanded] = useState(layout === "original" || layout === "steps");
  const toggle = useCallback(() => onChange(index), [index, onChange]);
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const expand = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View style={[styles.task, layout === "board" && styles.card]}>
      <View style={styles.row}>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={task.status === 2 ? Check : undefined}
          onPress={toggle}
          accessibilityLabel={`Change status: ${task.title}`}
        >
          {task.status !== 2 && (layout === "steps" ? String(index + 1).padStart(2, "0") : "○")}
        </Button>
        <View style={styles.grow}>
          <Text style={[styles.text, task.status === 2 && styles.done]}>{task.title}</Text>
        </View>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={layout === "detail" ? MoreHorizontal : ChevronDown}
          onPress={layout === "detail" ? select : expand}
          accessibilityLabel={`Show notes: ${task.title}`}
        />
      </View>
      {layout !== "compact" && layout !== "detail" ? (
        <View style={styles.meta}>
          <StatusBadge
            size="xs"
            label={STATES[task.status]}
            variant={(["muted", "warning", "success"] as const)[task.status]}
          />
        </View>
      ) : null}
      {expanded && layout !== "detail" ? <Text style={styles.notes}>{task.notes}</Text> : null}
    </View>
  );
}

export function TodoDemo({ layout }: { layout: Layout }) {
  const compact = useIsCompactFormFactor();
  const [tasks, setTasks] = useState(TASKS);
  const [selected, setSelected] = useState(1);
  const [title, setTitle] = useState("");
  const [epoch, setEpoch] = useState(0);
  const change = useCallback(
    (index: number) =>
      setTasks((current) =>
        current.map((task, i) => (i === index ? { ...task, status: (task.status + 1) % 3 } : task)),
      ),
    [],
  );
  const add = useCallback(() => {
    if (!title.trim()) return;
    setTasks((current) => [...current, { title: title.trim(), notes: "", status: 0 }]);
    setTitle("");
    setEpoch((value) => value + 1);
  }, [title]);
  const current = tasks[selected];
  const row = (task: Task, index: number) => (
    <TaskRow
      key={index}
      task={task}
      index={index}
      layout={layout}
      onChange={change}
      onSelect={setSelected}
    />
  );
  const progress = `${tasks.filter((task) => task.status === 2).length}/${tasks.length}`;
  const focusIndex = Math.max(
    0,
    tasks.findIndex((task) => task.status === 1),
  );
  const finish = useCallback(() => change(focusIndex), [change, focusIndex]);
  return (
    <View
      style={[
        styles.window,
        (layout === "board" || layout === "detail") && !compact ? styles.wide : styles.narrow,
      ]}
      testID={`todo-preview-${layout}`}
    >
      <View style={styles.header}>
        <Text style={styles.heading}>To-do</Text>
        <Text style={styles.muted}>{progress} completed</Text>
        <View style={styles.grow} />
        <Button
          size="xs"
          variant="ghost"
          leftIcon={X}
          disabled
          accessibilityLabel="Close preview"
        />
      </View>
      <View style={styles.body}>
        {layout === "board" && (
          <View style={[styles.columns, compact && styles.stacked]}>
            {STATES.map((state, status) => (
              <View key={state} style={styles.column}>
                <View style={styles.section}>
                  <Text style={styles.heading}>{state}</Text>
                  <Text style={styles.muted}>
                    {tasks.filter((task) => task.status === status).length}
                  </Text>
                </View>
                {tasks.map((task, index) => (task.status === status ? row(task, index) : null))}
              </View>
            ))}
          </View>
        )}
        {layout === "detail" && (
          <View style={[styles.columns, compact && styles.stacked]}>
            <View style={styles.column}>{tasks.map(row)}</View>
            <View style={styles.detail}>
              <Text style={styles.muted}>Selected task</Text>
              <Text style={styles.heading}>{current.title}</Text>
              <StatusBadge label={STATES[current.status]} />
              <Text style={styles.text}>{current.notes}</Text>
              <Text style={styles.muted}>Select a row’s menu to read its notes.</Text>
            </View>
          </View>
        )}
        {layout === "focus" && (
          <>
            <Text style={styles.muted}>
              CURRENT STEP · {focusIndex + 1} OF {tasks.length}
            </Text>
            <View style={styles.focus}>
              <Text style={styles.heading}>{tasks[focusIndex].title}</Text>
              <Text style={styles.text}>{tasks[focusIndex].notes}</Text>
              <Button variant="default" size="sm" leftIcon={Check} onPress={finish}>
                Update progress
              </Button>
            </View>
            <Text style={styles.muted}>PROJECT CHECKLIST</Text>
            {tasks.map(row)}
          </>
        )}
        {!["board", "detail", "focus"].includes(layout) && (
          <View style={layout === "steps" ? styles.steps : undefined}>{tasks.map(row)}</View>
        )}
        <View style={styles.add}>
          <FormTextInput
            size="sm"
            placeholder="New task"
            accessibilityLabel="New task"
            initialValue={title}
            resetKey={epoch}
            onChangeText={setTitle}
          />
          <Button size="sm" leftIcon={Plus} onPress={add} disabled={!title.trim()}>
            Add task
          </Button>
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  window: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    alignSelf: "center",
    width: "100%",
  },
  narrow: { maxWidth: 360 },
  wide: { maxWidth: 860 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base, lineHeight: 21 },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  done: { color: theme.colors.foregroundMuted, textDecorationLine: "line-through" },
  grow: { flex: 1 },
  body: { padding: theme.spacing[3], gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  task: { paddingVertical: theme.spacing[2], gap: theme.spacing[2] },
  notes: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    paddingLeft: theme.spacing[8],
  },
  meta: { alignItems: "flex-start", paddingLeft: theme.spacing[8] },
  add: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  columns: { flexDirection: "row", gap: theme.spacing[4] },
  stacked: { flexDirection: "column" },
  column: { flex: 1, minWidth: 0 },
  section: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: theme.spacing[3],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[2],
  },
  detail: {
    flex: 1,
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    alignItems: "flex-start",
  },
  steps: { borderLeftWidth: 1, borderColor: theme.colors.border, paddingLeft: theme.spacing[2] },
  focus: {
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
  },
}));
