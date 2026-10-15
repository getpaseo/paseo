import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ListTodo,
  MoreHorizontal,
  X,
  Plus,
} from "lucide-react-native";
import type {
  WorkspaceTodo,
  WorkspaceTodoMutation,
  WorkspaceTodos,
} from "@getpaseo/protocol/workspace-todos";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScreenHeader } from "@/components/headers/screen-header";
import { MilestoneSection } from "./milestone-section";
import { groupTodoMilestones, mergeTodoOrder } from "./grouping";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { isWeb } from "@/constants/platform";
import { useTodoViews } from "./view-store";

const ThemedListTodo = withUnistyles(ListTodo);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedCheck = withUnistyles(Check);
const todoIconColor = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});
const TodoContext = createContext<{ open: boolean; toggle(): void } | null>(null);
export function WorkspaceTodosButton({ hideLabels = false }: { hideLabels?: boolean }) {
  const context = useContext(TodoContext);
  const { t } = useTranslation();
  const expandedState = useMemo(() => ({ expanded: context?.open ?? false }), [context?.open]);
  if (!context) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={ListTodo}
      onPress={context.toggle}
      accessibilityLabel={t("workspaceTodos.title")}
      accessibilityState={expandedState}
      testID="workspace-todos-toggle"
    >
      {hideLabels ? null : t("workspaceTodos.title")}
    </Button>
  );
}
interface EditDraft {
  milestone?: string;
  title?: string;
  notes?: string;
  revision: number;
}
interface Drafts {
  milestone: string;
  title: string;
  notes: string;
  edits: Record<string, EditDraft>;
  failed?: WorkspaceTodoMutation;
  error?: string;
}
// Drafts survive hiding the panel and switching workspaces within this app session.
const draftsByWorkspace = new Map<string, Drafts>();
const EMPTY_DRAFT: Drafts = { title: "", notes: "", milestone: "", edits: {} };
export function WorkspaceTodosHost({
  serverId,
  workspaceId,
  active,
  children,
}: {
  serverId: string;
  workspaceId: string;
  active: boolean;
  children: ReactNode;
}) {
  const key = JSON.stringify([serverId, workspaceId]);
  return (
    <TodoHost key={key} viewKey={key} serverId={serverId} workspaceId={workspaceId} active={active}>
      {children}
    </TodoHost>
  );
}
function TodoHost({
  viewKey,
  serverId,
  workspaceId,
  active,
  children,
}: {
  viewKey: string;
  serverId: string;
  workspaceId: string;
  active: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const view = useTodoViews((state) => state.views[viewKey]);
  const setView = useTodoViews((state) => state.setView);
  const open = view?.open ?? false;
  const close = useCallback(() => setView(viewKey, { open: false }), [setView, viewKey]);
  const toggle = useCallback(() => setView(viewKey, { open: !open }), [setView, viewKey, open]);
  const contextValue = useMemo(() => ({ open, toggle }), [open, toggle]);
  const [list, setList] = useState<WorkspaceTodos | null>(null);
  const [draft, setDraft] = useState<Drafts>(() => draftsByWorkspace.get(viewKey) ?? EMPTY_DRAFT);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [inputEpoch, setInputEpoch] = useState(0);
  const capability = client?.getLastServerInfoMessage()?.features?.workspaceTodoMilestones === true;
  useEffect(() => {
    draftsByWorkspace.set(viewKey, draft);
  }, [draft, viewKey]);
  useEffect(() => {
    if (!active || !open || !client || !capability) return;
    const subscription = client.observeWorkspaceTodos(workspaceId);
    const accept = (next: WorkspaceTodos) => {
      setList((current) => (!current || next.revision >= current.revision ? next : current));
      setLoadError(undefined);
    };
    const stop = subscription.subscribe({
      snapshot: (snapshot) => accept(snapshot.list),
      update: (message) => {
        if (message.type === "workspace.todos.changed") accept(message.payload.list);
      },
      error: (error) =>
        setLoadError(error instanceof Error ? error.message : t("common.errors.unableToSave")),
    });
    return () => {
      stop();
      void subscription.release().catch(() => {});
    };
  }, [active, capability, client, open, t, workspaceId]);
  const mutate = useCallback(
    async (mutation: WorkspaceTodoMutation, revision = list?.revision) => {
      if (pending || revision === undefined) return;
      setPending(true);
      try {
        if (!client?.isConnected) throw new Error(t("workspace.terminal.hostDisconnected"));
        const next = await client.mutateWorkspaceTodos(workspaceId, revision, mutation);
        setList((current) => (!current || next.revision >= current.revision ? next : current));
        setDraft((current) => {
          const edits = { ...current.edits };
          if (
            mutation.operation === "delete" ||
            (mutation.operation === "update" &&
              (mutation.title !== undefined ||
                mutation.notes !== undefined ||
                mutation.milestone !== undefined))
          )
            delete edits[mutation.id];
          return {
            ...current,
            ...(mutation.operation === "add" ? { title: "", notes: "" } : {}),
            edits,
            failed: undefined,
            error: undefined,
          };
        });
        setInputEpoch((epoch) => epoch + 1);
      } catch (error) {
        setDraft((current) => ({
          ...current,
          failed: mutation,
          error: error instanceof Error ? error.message : t("common.errors.unableToSave"),
        }));
      } finally {
        setPending(false);
      }
    },
    [client, list?.revision, pending, t, workspaceId],
  );
  const retry = useCallback(async () => {
    if (!client || !draft.failed || pending) return;
    try {
      const fresh = await client.getWorkspaceTodos(workspaceId);
      setList(fresh.list);
      await mutate(draft.failed, fresh.list.revision);
    } catch (error) {
      setDraft((current) => ({
        ...current,
        error: error instanceof Error ? error.message : t("common.errors.unableToSave"),
      }));
    }
  }, [client, draft.failed, mutate, pending, t, workspaceId]);
  const changeEdit = useCallback(
    (task: WorkspaceTodo, field: "title" | "notes" | "milestone", text: string) =>
      setDraft((current) => ({
        ...current,
        failed: undefined,
        error: undefined,
        edits: {
          ...current.edits,
          [task.id]: { ...(current.edits[task.id] ?? { revision: list!.revision }), [field]: text },
        },
      })),
    [list],
  );
  const reorder = useCallback(
    (tasks: WorkspaceTodo[]) =>
      void mutate({ operation: "reorder", ids: mergeTodoOrder(list!.tasks, tasks) }),
    [mutate, list],
  );
  const toggleNotes = useCallback(
    (id: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const renderTask = useCallback(
    (info: DraggableRenderItemInfo<WorkspaceTodo>) => (
      <TodoRow
        info={info}
        list={list!}
        draft={draft.edits[info.item.id]}
        expanded={expanded.has(info.item.id) || Boolean(draft.edits[info.item.id])}
        pending={pending}
        epoch={inputEpoch}
        onEdit={changeEdit}
        onMutate={mutate}
        onToggleNotes={toggleNotes}
        onReorder={reorder}
      />
    ),
    [list, draft.edits, expanded, pending, inputEpoch, changeEdit, mutate, toggleNotes, reorder],
  );
  const onNewTitle = useCallback(
    (title: string) =>
      setDraft((current) => ({ ...current, title, failed: undefined, error: undefined })),
    [],
  );
  const onNewNotes = useCallback(
    (notes: string) =>
      setDraft((current) => ({ ...current, notes, failed: undefined, error: undefined })),
    [],
  );
  const onNewMilestone = useCallback(
    (milestone: string) =>
      setDraft((current) => ({ ...current, milestone, failed: undefined, error: undefined })),
    [],
  );
  const add = useCallback(
    () =>
      void mutate({
        operation: "add",
        title: draft.title,
        notes: draft.notes,
        milestone: draft.milestone,
      }),
    [draft.title, draft.notes, draft.milestone, mutate],
  );
  const extraData = useMemo(
    () => ({ draft, expanded, pending, inputEpoch }),
    [draft, expanded, pending, inputEpoch],
  );
  const empty = useMemo(() => <Text style={styles.text}>{t("workspaceTodos.empty")}</Text>, [t]);
  const content = (
    <TodoContent
      connected={connected}
      capability={capability}
      list={list}
      draft={draft}
      pending={pending}
      loadError={loadError}
      epoch={inputEpoch}
      extraData={extraData}
      empty={empty}
      onRetry={retry}
      renderTask={renderTask}
      onReorder={reorder}
      onNewTitle={onNewTitle}
      onNewMilestone={onNewMilestone}
      onNewNotes={onNewNotes}
      onAdd={add}
    />
  );
  const counter = list
    ? `${list.tasks.filter((task) => task.status === "done").length}/${list.tasks.length}`
    : "";
  const header = useMemo(
    () => ({ title: t("workspaceTodos.title"), subtitle: counter }),
    [t, counter],
  );
  const headerLeft = useMemo(
    () => (
      <>
        <ThemedListTodo size={16} uniProps={todoIconColor} />
        <Text style={styles.heading}>{t("workspaceTodos.title")}</Text>
        <Text style={styles.text} testID="workspace-todos-counter">
          {counter}
        </Text>
      </>
    ),
    [t, counter],
  );
  const headerRight = useMemo(
    () => (
      <Button
        variant="ghost"
        size={size}
        leftIcon={X}
        onPress={close}
        accessibilityLabel={t("workspaceTodos.close")}
        testID="workspace-todos-close"
      />
    ),
    [size, close, t],
  );
  return (
    <TodoContext.Provider value={contextValue}>
      <View style={styles.host}>
        {!compact && active && open && (
          <View style={styles.panel} testID="workspace-todos-panel">
            <ScreenHeader left={headerLeft} right={headerRight} />
            {content}
          </View>
        )}
        <View style={styles.workspace}>{children}</View>
        {compact && (
          <AdaptiveModalSheet
            visible={active && open}
            onClose={close}
            header={header}
            testID="workspace-todos-sheet"
          >
            {content}
          </AdaptiveModalSheet>
        )}
      </View>
    </TodoContext.Provider>
  );
}

import { ScrollView } from "@/components/ui/scroll-view";
interface ContentProps {
  connected: boolean;
  capability: boolean;
  list: WorkspaceTodos | null;
  draft: Drafts;
  pending: boolean;
  loadError?: string;
  epoch: number;
  extraData: unknown;
  empty: import("react").ReactElement;
  onRetry(): Promise<void>;
  onReorder(tasks: WorkspaceTodo[]): void;
  renderTask(info: DraggableRenderItemInfo<WorkspaceTodo>): import("react").ReactElement;
  onNewTitle(text: string): void;
  onNewMilestone(text: string): void;
  onNewNotes(text: string): void;
  onAdd(): void;
}
function TodoContent({
  connected,
  capability,
  list,
  draft,
  pending,
  loadError,
  epoch,
  extraData,
  empty,
  onRetry,
  renderTask,
  onReorder,
  onNewTitle,
  onNewNotes,
  onNewMilestone,
  onAdd,
}: ContentProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const groups = useMemo(() => groupTodoMilestones(list?.tasks ?? []), [list]);
  const editingIds = useMemo(() => new Set(Object.keys(draft.edits)), [draft.edits]);
  const completed = list?.tasks.filter((task) => task.status === "done").length ?? 0;
  if (!connected && !list)
    return <Text style={styles.error}>{t("workspace.terminal.hostDisconnected")}</Text>;
  if (!capability && !list)
    return (
      <Text style={styles.text} testID="workspace-todos-update-host">
        {t("workspaceTodos.updateHost")}
      </Text>
    );
  const body = (
    <View style={styles.body}>
      {!connected ? (
        <Text style={styles.error} accessibilityRole="alert">
          {t("workspace.terminal.hostDisconnected")}
        </Text>
      ) : null}
      {loadError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {loadError}
        </Text>
      ) : null}
      {draft.error ? (
        <View style={styles.errorBlock}>
          <Text style={styles.error} accessibilityRole="alert" testID="workspace-todos-error">
            {draft.error}
          </Text>
          <Button size={size} onPress={onRetry} disabled={pending} testID="workspace-todos-retry">
            {t("workspaceTodos.retry")}
          </Button>
        </View>
      ) : null}
      {!list ? (
        <Text style={styles.text}>{t("common.loading")}</Text>
      ) : (
        <>
          <View style={styles.progressBlock}>
            <View style={styles.row}>
              <Text style={styles.status}>{t("workspaceTodos.progress")}</Text>
              <Text style={styles.text}>
                {completed}/{list.tasks.length}
              </Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={styles.progressFill(list.tasks.length ? completed / list.tasks.length : 0)}
              />
            </View>
          </View>
          <View style={styles.intro}>
            <Text style={styles.introTitle}>{t("workspaceTodos.headline")}</Text>
            <Text style={styles.status}>{t("workspaceTodos.subtitle")}</Text>
          </View>
          {groups.length === 0
            ? empty
            : groups.map((group, index) => (
                <MilestoneSection
                  key={group.name}
                  group={group}
                  index={index}
                  editingIds={editingIds}
                  extraData={extraData}
                  renderTask={renderTask}
                  onReorder={onReorder}
                />
              ))}
        </>
      )}
    </View>
  );
  const addForm = list ? (
    <TodoAddForm
      connected={connected}
      draft={draft}
      pending={pending}
      epoch={epoch}
      onNewTitle={onNewTitle}
      onNewNotes={onNewNotes}
      onNewMilestone={onNewMilestone}
      onAdd={onAdd}
    />
  ) : null;
  if (compact)
    return (
      <View>
        {body}
        {addForm}
      </View>
    );
  return (
    <View style={styles.workspace}>
      <ScrollView style={styles.scroll}>{body}</ScrollView>
      {addForm}
    </View>
  );
}

function TodoAddForm({
  connected,
  draft,
  pending,
  epoch,
  onNewTitle,
  onNewNotes,
  onNewMilestone,
  onAdd,
}: Pick<
  ContentProps,
  | "connected"
  | "draft"
  | "pending"
  | "epoch"
  | "onNewTitle"
  | "onNewNotes"
  | "onNewMilestone"
  | "onAdd"
>) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [addDetails, setAddDetails] = useState(false);
  const toggleDetails = useCallback(() => setAddDetails((value) => !value), []);
  return (
    <View style={styles.add}>
      <View style={styles.row}>
        <View style={styles.titleInput}>
          <FormTextInput
            size={size}
            multiline
            initialValue={draft.title}
            resetKey={epoch}
            onChangeText={onNewTitle}
            placeholder={t("workspaceTodos.add")}
            accessibilityLabel={t("workspaceTodos.taskTitle")}
            editable={!pending && connected}
            testID="workspace-todos-new-title"
          />
        </View>
        <Button
          size={size}
          variant="ghost"
          leftIcon={Plus}
          disabled={pending || !connected || !draft.title.trim()}
          onPress={onAdd}
          accessibilityLabel={t("workspaceTodos.add")}
          testID="workspace-todos-add"
        />
      </View>
      {draft.title || draft.notes || addDetails ? (
        <Button
          size="xs"
          variant="ghost"
          leftIcon={addDetails ? ChevronDown : ChevronRight}
          onPress={toggleDetails}
          testID="workspace-todos-add-details"
        >
          {t("workspaceTodos.details")}
        </Button>
      ) : null}
      {addDetails && (
        <>
          <Field label={t("workspaceTodos.milestone")}>
            <FormTextInput
              size={size}
              initialValue={draft.milestone}
              resetKey={epoch}
              onChangeText={onNewMilestone}
              placeholder={t("workspaceTodos.ungrouped")}
              editable={!pending}
              testID="workspace-todos-new-milestone"
            />
          </Field>
          <FormTextInput
            size={size}
            initialValue={draft.notes}
            resetKey={epoch}
            onChangeText={onNewNotes}
            placeholder={t("workspaceTodos.notes")}
            accessibilityLabel={t("workspaceTodos.notes")}
            multiline
            editable={!pending}
            testID="workspace-todos-new-notes"
          />
        </>
      )}
    </View>
  );
}

interface RowProps {
  info: DraggableRenderItemInfo<WorkspaceTodo>;
  list: WorkspaceTodos;
  draft?: EditDraft;
  expanded: boolean;
  pending: boolean;
  epoch: number;
  onEdit(task: WorkspaceTodo, field: "title" | "notes" | "milestone", text: string): void;
  onMutate(mutation: WorkspaceTodoMutation, revision?: number): Promise<void>;
  onToggleNotes(id: string): void;
  onReorder(tasks: WorkspaceTodo[]): void;
}
function TodoRow({
  info: { item: task, drag, dragHandleProps },
  list,
  draft,
  expanded,
  pending,
  epoch,
  onEdit,
  onMutate,
  onToggleNotes,
  onReorder,
}: RowProps) {
  const { t } = useTranslation();
  const index = list.tasks.findIndex((item) => item.id === task.id);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const checked = useMemo(
    () => ({ checked: task.status === "done", disabled: pending }),
    [task.status, pending],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const toggle = useCallback(
    () =>
      void onMutate({
        operation: "update",
        id: task.id,
        status: task.status === "done" ? "todo" : "done",
      }),
    [onMutate, task],
  );
  const notes = useCallback(() => onToggleNotes(task.id), [onToggleNotes, task.id]);
  const save = useCallback(() => {
    if (draft)
      void onMutate(
        {
          operation: "update",
          id: task.id,
          title: draft.title,
          notes: draft.notes,
          milestone: draft.milestone,
        },
        draft.revision,
      );
  }, [draft, onMutate, task.id]);
  const remove = useCallback(
    () => void onMutate({ operation: "delete", id: task.id }),
    [onMutate, task.id],
  );
  const todo = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "todo" }),
    [onMutate, task.id],
  );
  const inProgress = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "in_progress" }),
    [onMutate, task.id],
  );
  const done = useCallback(
    () => void onMutate({ operation: "update", id: task.id, status: "done" }),
    [onMutate, task.id],
  );
  const move = useCallback(
    (offset: number) => {
      const tasks = [...list.tasks];
      const [item] = tasks.splice(index, 1);
      if (!item) return;
      tasks.splice(index + offset, 0, item);
      onReorder(tasks);
    },
    [list.tasks, index, onReorder],
  );
  const moveUp = useCallback(() => move(-1), [move]);
  const moveDown = useCallback(() => move(1), [move]);
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.menuTrigger}
        accessibilityLabel={t("workspaceTodos.taskMenu")}
        testID={`workspace-todo-menu-${task.id}`}
      >
        <ThemedMoreHorizontal size={16} uniProps={todoIconColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem disabled={pending} onSelect={todo}>
          {t("workspaceTodos.todo")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={inProgress}>
          {t("workspaceTodos.in_progress")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={done}>
          {t("workspaceTodos.done")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending || index === 0} onSelect={moveUp}>
          {t("workspaceTodos.moveUp")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending || index === list.tasks.length - 1} onSelect={moveDown}>
          {t("workspaceTodos.moveDown")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={pending} onSelect={remove}>
          {t("workspaceTodos.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <View style={styles.task} testID={`workspace-todo-${task.id}`}>
      <View style={styles.row}>
        <TodoDragHandle
          taskId={task.id}
          drag={drag}
          dragHandleProps={dragHandleProps}
          pending={pending}
        />
        <Pressable
          hitSlop={12}
          accessibilityRole="checkbox"
          accessibilityState={checked}
          accessibilityLabel={task.title}
          disabled={pending}
          onPress={toggle}
          testID={`workspace-todo-check-${task.id}`}
          style={[styles.checkbox, task.status === "in_progress" && styles.activeCheckbox]}
        >
          {task.status === "done" ? <ThemedCheck size={14} uniProps={todoIconColor} /> : null}
          {task.status === "in_progress" ? <View style={styles.activeDot} /> : null}
        </Pressable>
        <Pressable
          onPress={notes}
          accessibilityRole="button"
          accessibilityState={expandedState}
          style={styles.titleInput}
          testID={`workspace-todo-notes-toggle-${task.id}`}
        >
          <Text
            style={[styles.taskTitle, task.status === "done" && styles.doneTitle]}
            testID={`workspace-todo-label-${task.id}`}
          >
            {draft?.title ?? task.title}
          </Text>
        </Pressable>
        {menu}
      </View>
      <Text style={styles.rowStatus} testID={`workspace-todo-status-${task.id}`}>
        {t(`workspaceTodos.${task.status}`)}
      </Text>
      {expanded ? (
        <TodoEditor
          task={task}
          draft={draft}
          pending={pending}
          epoch={epoch}
          revision={list.revision}
          onEdit={onEdit}
        />
      ) : null}
      {draft ? (
        <View style={styles.row}>
          <Text style={styles.status}>{t("workspaceTodos.unsaved")}</Text>
          <Button
            size={size}
            onPress={save}
            disabled={pending || !(draft.title ?? task.title).trim()}
            testID={`workspace-todo-save-${task.id}`}
          >
            {t("workspaceTodos.save")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
function TodoEditor({
  task,
  draft,
  pending,
  epoch,
  revision,
  onEdit,
}: Pick<RowProps, "draft" | "pending" | "epoch" | "onEdit"> & {
  task: WorkspaceTodo;
  revision: number;
}) {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const changeTitle = useCallback((text: string) => onEdit(task, "title", text), [onEdit, task]);
  const changeMilestone = useCallback(
    (text: string) => onEdit(task, "milestone", text),
    [onEdit, task],
  );
  const changeNotes = useCallback((text: string) => onEdit(task, "notes", text), [onEdit, task]);
  return (
    <View style={styles.details}>
      <Field label={t("workspaceTodos.taskTitle")}>
        <FormTextInput
          size={size}
          initialValue={draft?.title ?? task.title}
          resetKey={`${epoch}:${draft ? "draft" : revision}`}
          onChangeText={changeTitle}
          multiline
          editable={!pending}
          testID={`workspace-todo-title-${task.id}`}
        />
      </Field>
      <Field label={t("workspaceTodos.milestone")}>
        <FormTextInput
          size={size}
          initialValue={draft?.milestone ?? task.milestone ?? ""}
          resetKey={`${epoch}:${draft ? "draft" : revision}`}
          onChangeText={changeMilestone}
          placeholder={t("workspaceTodos.ungrouped")}
          editable={!pending}
          testID={`workspace-todo-milestone-input-${task.id}`}
        />
      </Field>
      <Field label={t("workspaceTodos.notes")}>
        <FormTextInput
          size={size}
          initialValue={draft?.notes ?? task.notes}
          resetKey={`${epoch}:${draft ? "draft" : revision}`}
          multiline
          numberOfLines={3}
          onChangeText={changeNotes}
          editable={!pending}
          testID={`workspace-todo-notes-${task.id}`}
        />
      </Field>
    </View>
  );
}

function TodoDragHandle({
  taskId,
  drag,
  dragHandleProps,
  pending,
}: Pick<DraggableRenderItemInfo<WorkspaceTodo>, "drag" | "dragHandleProps"> & {
  pending: boolean;
  taskId: string;
}) {
  const { t } = useTranslation();
  return (
    <View
      {...(isWeb && !pending ? dragHandleProps?.attributes : {})}
      {...(isWeb && !pending ? dragHandleProps?.listeners : {})}
      ref={isWeb ? (dragHandleProps?.setActivatorNodeRef as Ref<View>) : undefined}
      testID={`workspace-todo-drag-${taskId}`}
      style={styles.taskDragHandle}
    >
      <Pressable
        onLongPress={drag}
        style={styles.taskDragHandle}
        disabled={pending}
        accessibilityLabel={t("workspaceTodos.reorder")}
      >
        <ThemedGripVertical size={14} uniProps={todoIconColor} />
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  taskDragHandle: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    touchAction: "none",
    cursor: "pointer",
  },
  host: { flex: 1, minHeight: 0, minWidth: 0, flexDirection: "row" },
  workspace: { flex: 1, minWidth: 0, minHeight: 0 },
  panel: {
    width: 388,
    maxWidth: "45%",
    minHeight: 0,
    backgroundColor: theme.colors.workspace.chrome,
    borderRightWidth: 1,
    borderColor: theme.colors.border,
  },
  heading: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  scroll: { flex: 1, minHeight: 0 },
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  task: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  titleInput: { flex: 1, minWidth: 0 },
  menuTrigger: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  add: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  details: { gap: theme.spacing[3], paddingVertical: theme.spacing[2] },
  taskTitle: { fontSize: theme.fontSize.base, lineHeight: 22, color: theme.colors.foreground },
  doneTitle: { color: theme.colors.foregroundMuted },
  rowStatus: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[8],
  },
  activeCheckbox: { borderColor: theme.colors.accent },
  activeDot: { width: 8, height: 8, borderRadius: 2, backgroundColor: theme.colors.accent },
  progressBlock: { gap: theme.spacing[2] },
  progressTrack: {
    height: 4,
    borderRadius: 4,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  progressFill: (progress: number) => ({
    height: "100%",
    width: `${progress * 100}%`,
    backgroundColor: theme.colors.accent,
  }),
  intro: { gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
  introTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  errorBlock: { gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
