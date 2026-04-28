import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Plus } from "lucide-react-native";
import type { KanbanTask, KanbanStatus } from "@/types/kanban";
import { KANBAN_COLUMNS, KANBAN_TITLES } from "@/types/kanban";
import { useKanbanStore, selectTasksByStatus } from "@/stores/kanban-store";
import { KanbanColumn } from "./kanban-column";
import { KanbanCard } from "./kanban-card";
import { KanbanEmpty } from "./kanban-empty";

interface KanbanBoardProps {
  serverId?: string;
  tasks?: KanbanTask[];
  statusByTask?: Record<string, KanbanStatus>;
  onStatusChange?: (taskId: string, status: KanbanStatus) => void;
  onOpenTask?: (task: KanbanTask) => void;
  onCreateTask?: () => void;
}

interface DraggableTaskCardProps {
  task: KanbanTask;
  serverId?: string;
  onOpenTask?: (task: KanbanTask) => void;
}

function DraggableTaskCard({ task, serverId, onOpenTask }: DraggableTaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    data: { taskId: task.id },
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.35 : 1,
    cursor: isDragging ? "grabbing" : "grab",
    touchAction: "none",
  };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <KanbanCard task={task} serverId={serverId} onPress={onOpenTask} />
    </div>
  );
}

interface DroppableColumnProps {
  status: KanbanStatus;
  children: ReactNode | ((isOver: boolean) => ReactNode);
}

function DroppableColumn({ status, children }: DroppableColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    data: { status },
  });

  const style: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
  };

  return (
    <div ref={setNodeRef} style={style}>
      {typeof children === "function" ? children(isOver) : children}
    </div>
  );
}

export function KanbanBoard({
  serverId,
  tasks: tasksProp,
  statusByTask: statusByTaskProp,
  onStatusChange,
  onOpenTask,
  onCreateTask,
}: KanbanBoardProps) {
  const { theme } = useUnistyles();
  const isCompact = useIsCompactFormFactor();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const storeTasks = useKanbanStore((s) => s.tasks);
  const storeStatusByTask = useKanbanStore((s) => s.statusByTask);
  const setStatus = useKanbanStore((s) => s.setStatus);
  const tasks = tasksProp ?? storeTasks;
  const statusByTask = statusByTaskProp ?? storeStatusByTask;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );

  const byStatus = useMemo(() => selectTasksByStatus(tasks, statusByTask), [tasks, statusByTask]);
  const hasAny = tasks.length > 0;

  const handleStatusChange = useCallback(
    (taskId: string, status: KanbanStatus) => {
      if (onStatusChange) {
        onStatusChange(taskId, status);
        return;
      }
      setStatus(taskId, status);
    },
    [onStatusChange, setStatus],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveTaskId(String(event.active.id ?? ""));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTaskId(null);
      const taskId = String(event.active.id ?? "").trim();
      const targetStatus =
        typeof event.over?.id === "string" && KANBAN_COLUMNS.includes(event.over.id as KanbanStatus)
          ? (event.over.id as KanbanStatus)
          : null;

      if (!taskId || !targetStatus) {
        return;
      }

      const currentStatus = statusByTask[taskId];
      if (currentStatus === targetStatus) {
        return;
      }

      handleStatusChange(taskId, targetStatus);
    },
    [handleStatusChange, statusByTask],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTaskId(null);
  }, []);

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : null;

  const renderColumn = (status: KanbanStatus, isDropTarget = false) => {
    const columnTasks = byStatus[status];
    const isTodo = status === "todo";

    return (
      <KanbanColumn
        key={status}
        title={KANBAN_TITLES[status]}
        count={columnTasks.length}
        status={status}
        isDropTarget={activeTaskId !== null && isDropTarget}
        action={
          isTodo && onCreateTask ? (
            <Pressable
              style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
              onPress={onCreateTask}
            >
              <Plus size={16} color={theme.colors.foreground} />
            </Pressable>
          ) : undefined
        }
      >
        {columnTasks.length === 0 ? (
          <KanbanEmpty showCreateButton={isTodo && !hasAny} onCreateTask={onCreateTask} />
        ) : (
          <>
            {columnTasks.map((task) => (
              <DraggableTaskCard
                key={task.id}
                task={task}
                serverId={serverId}
                onOpenTask={onOpenTask}
              />
            ))}
            {isTodo && onCreateTask ? (
              <Pressable
                style={({ pressed }) => [
                  styles.inlineCreateButton,
                  pressed && styles.inlineCreateButtonPressed,
                ]}
                onPress={onCreateTask}
              >
                <Plus size={14} color={theme.colors.foregroundMuted} />
                <Text style={styles.inlineCreateText}>New Task</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </KanbanColumn>
    );
  };

  if (isCompact) {
    return (
      <ScrollView
        style={styles.mobileContainer}
        contentContainerStyle={styles.mobileContent}
        showsVerticalScrollIndicator={false}
      >
        {KANBAN_COLUMNS.map((status) => renderColumn(status))}
      </ScrollView>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <View style={styles.desktopContainer}>
        {KANBAN_COLUMNS.map((status) => (
          <DroppableColumn key={status} status={status}>
            {(isOver: boolean) => renderColumn(status, isOver)}
          </DroppableColumn>
        ))}
      </View>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div style={{ cursor: "grabbing", opacity: 0.95 }}>
            <KanbanCard task={activeTask} serverId={serverId} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const styles = StyleSheet.create((theme) => ({
  desktopContainer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[4],
    padding: theme.spacing[3],
  },
  mobileContainer: {
    flex: 1,
  },
  mobileContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonPressed: {
    opacity: 0.7,
  },
  inlineCreateButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    marginTop: theme.spacing[1],
  },
  inlineCreateButtonPressed: {
    opacity: 0.7,
  },
  inlineCreateText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
