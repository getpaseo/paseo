import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ArchiveRestore,
  BellOff,
  CircleStop,
  Flag,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Goal, GoalEvent, GoalPriority } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import {
  GOAL_PRIORITIES,
  goalAvailableActions,
  goalPriority,
  hasAnyGoalAction,
  type GoalActions,
} from "@/goals/goal-management";
import { retainedSummary } from "@/goals/goal-labels";
import { goalRetryLabelKey } from "@/goals/goal-phase";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useHostFeature } from "@/runtime/host-features";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { useRetryTimeChoice } from "./goal-retry-time-sheet";
import { GoalSettingsSheet } from "./goal-settings-sheet";

const ICON_SIZE = 14;
const RETAINED_TOAST_MS = 8000;
const PRIORITY_PAGE_ID = "priority";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedFlag = withUnistyles(Flag);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedBellOff = withUnistyles(BellOff);
const ThemedArchive = withUnistyles(Archive);
const ThemedArchiveRestore = withUnistyles(ArchiveRestore);
const ThemedCircleStop = withUnistyles(CircleStop);
const ThemedTrash = withUnistyles(Trash2);
const ThemedSliders = withUnistyles(SlidersHorizontal);

const renameIcon = <ThemedPencil size={ICON_SIZE} uniProps={mutedColorMapping} />;
const priorityIcon = <ThemedFlag size={ICON_SIZE} uniProps={mutedColorMapping} />;
const pauseIcon = <ThemedPause size={ICON_SIZE} uniProps={mutedColorMapping} />;
const resumeIcon = <ThemedPlay size={ICON_SIZE} uniProps={mutedColorMapping} />;
const retryIcon = <ThemedRotateCcw size={ICON_SIZE} uniProps={mutedColorMapping} />;
const dismissIcon = <ThemedBellOff size={ICON_SIZE} uniProps={mutedColorMapping} />;
const archiveIcon = <ThemedArchive size={ICON_SIZE} uniProps={mutedColorMapping} />;
const unarchiveIcon = <ThemedArchiveRestore size={ICON_SIZE} uniProps={mutedColorMapping} />;
const cancelIcon = <ThemedCircleStop size={ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteIcon = <ThemedTrash size={ICON_SIZE} uniProps={mutedColorMapping} />;
const settingsIcon = <ThemedSliders size={ICON_SIZE} uniProps={mutedColorMapping} />;

function renderTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedMoreVertical
      size={ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

/** The actions a goal offers on its host, from the host's flags and the goal's state. */
export function useGoalActions(serverId: string, goal: Goal): GoalActions {
  const controls = useHostFeature(serverId, "goalControls");
  const acknowledge = useHostFeature(serverId, "goalAcknowledge");
  const management = useHostFeature(serverId, "goalManagement");
  const configEdit = useHostFeature(serverId, "goalConfigEdit");
  const integrationRetry = useHostFeature(serverId, "goalIntegrationRetry");
  const reworkRetry = useHostFeature(serverId, "goalReworkRetry");
  return useMemo(
    () =>
      goalAvailableActions(goal, {
        controls,
        acknowledge,
        management,
        configEdit,
        integrationRetry,
        reworkRetry,
      }),
    [acknowledge, configEdit, controls, goal, integrationRetry, management, reworkRetry],
  );
}

/**
 * Runs goal actions and reports failures as a toast. Cancel and delete ask first; delete then
 * says what it kept.
 */
export function useGoalActionHandlers(serverId: string, options: { onDeleted?: () => void } = {}) {
  const { t } = useTranslation();
  const toast = useToast();
  const mutations = useGoalMutations({ serverId });
  const { onDeleted } = options;
  const report = useCallback(
    (action: Promise<unknown>) => {
      action.catch((error: unknown) => toast.error(toErrorMessage(error)));
    },
    [toast],
  );
  const { pause, resume, retry, acknowledge, archive, unarchive, setPriority, cancelGoal } =
    mutations;
  const { deleteGoal, rename } = mutations;

  const confirmCancel = useCallback(
    async (goal: Goal) => {
      const confirmed = await confirmDialog({
        title: t("goals.detail.cancelConfirmTitle"),
        message: t("goals.detail.cancelConfirmMessage"),
        confirmLabel: t("goals.detail.cancelGoal"),
        cancelLabel: t("goals.detail.keepGoal"),
        destructive: true,
      });
      if (confirmed) {
        report(cancelGoal(goal.id));
      }
    },
    [cancelGoal, report, t],
  );

  const confirmDelete = useCallback(
    async (goal: Goal) => {
      const branch = goal.integration?.branch;
      const confirmed = await confirmDialog({
        title: t("goals.actions.deleteConfirmTitle"),
        message: branch
          ? t("goals.actions.deleteConfirmMessage", { branch })
          : t("goals.actions.deleteConfirmMessageNoBranch"),
        confirmLabel: t("goals.actions.delete"),
        cancelLabel: t("goals.detail.keepGoal"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await deleteGoal(goal.id);
        onDeleted?.();
        // What stays (branches, worktrees with uncommitted work) is worth reading, so it stays up.
        if (result.retained.length > 0) {
          toast.show(retainedSummary(t, result.retained), {
            durationMs: RETAINED_TOAST_MS,
            testID: "goal-deleted-toast",
          });
        } else {
          toast.show(t("goals.actions.deleted"), { testID: "goal-deleted-toast" });
        }
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [deleteGoal, onDeleted, t, toast],
  );

  return useMemo(
    () => ({
      pause: (goal: Goal) => report(pause(goal.id)),
      resume: (goal: Goal) => report(resume(goal.id)),
      retry: (goal: Goal) => report(retry({ goalId: goal.id })),
      dismiss: (goal: Goal) => report(acknowledge(goal.id)),
      archive: (goal: Goal) => report(archive(goal.id)),
      unarchive: (goal: Goal) => report(unarchive(goal.id)),
      setPriority: (goal: Goal, priority: GoalPriority) =>
        report(setPriority({ goalId: goal.id, priority })),
      cancel: (goal: Goal) => void confirmCancel(goal),
      delete: (goal: Goal) => void confirmDelete(goal),
      /** Rejects with the host's error so the rename sheet can show it under the field. */
      rename: (goal: Goal, title: string) => rename({ goalId: goal.id, title }),
      isRenaming: mutations.isRenaming,
    }),
    [
      acknowledge,
      archive,
      confirmCancel,
      confirmDelete,
      mutations.isRenaming,
      pause,
      rename,
      report,
      resume,
      retry,
      setPriority,
      unarchive,
    ],
  );
}

type GoalActionHandlers = ReturnType<typeof useGoalActionHandlers>;

/**
 * The kebab menu for one goal: on its list row and in its detail. It offers only what the
 * daemon accepts for the goal's state and the host's flags, and renders nothing when that is
 * nothing.
 */
export function GoalActionsMenu({
  serverId,
  goal,
  events,
  onDeleted,
  open,
  onOpenChange,
  testID,
}: {
  serverId: string;
  goal: Goal;
  /**
   * The goal's history, when the caller has it (the detail does, a list row does not). With it
   * the retry's time choice says how much Remaining leaves and turns it off when nothing does;
   * without it the host refuses a Remaining that leaves nothing.
   */
  events?: readonly GoalEvent[];
  /** Called after the goal was deleted, such as to leave its detail. */
  onDeleted?: () => void;
  /** Lifted so a hover-revealed trigger stays while its menu is up (docs/hover.md). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const actions = useGoalActions(serverId, goal);
  const handlers = useGoalActionHandlers(serverId, { onDeleted });
  const toast = useToast();
  const retryChoice = useRetryTimeChoice({ serverId, goal, events });
  const [sheet, setSheet] = useState<"rename" | "settings" | null>(null);
  const openRename = useCallback(() => setSheet("rename"), []);
  const openSettings = useCallback(() => setSheet("settings"), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const retryWithChoice = retryChoice.retry;
  const handleRetry = useCallback(() => {
    retryWithChoice().catch((error: unknown) => toast.error(toErrorMessage(error)));
  }, [retryWithChoice, toast]);
  const priority = goalPriority(goal);

  const pages = useMemo<MenuPageDefinition[]>(
    () =>
      actions.priority
        ? [
            {
              id: PRIORITY_PAGE_ID,
              title: t("goals.priority.label"),
              content: (
                <PriorityPage
                  goal={goal}
                  current={priority}
                  handlers={handlers}
                  testID={`${testID}-priority`}
                />
              ),
            },
          ]
        : [],
    [actions.priority, goal, handlers, priority, t, testID],
  );

  if (!hasAnyGoalAction(actions)) {
    return null;
  }
  const hasStateActions = actions.pause || actions.resume || actions.retry || actions.dismiss;
  const hasEditActions = actions.rename || actions.priority || actions.editSettings;

  return (
    <>
      <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          hitSlop={8}
          style={triggerStyle}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={t("goals.actions.menu")}
          testID={testID}
        >
          {renderTriggerIcon}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          width={240}
          pages={pages}
          sheetTitle={goal.title}
          testID={`${testID}-content`}
        >
          <EditItems
            actions={actions}
            priority={priority}
            onRename={openRename}
            onEditSettings={openSettings}
            testID={testID}
          />
          {hasEditActions && hasStateActions ? <DropdownMenuSeparator /> : null}
          <StateItems
            goal={goal}
            actions={actions}
            handlers={handlers}
            onRetry={handleRetry}
            testID={testID}
          />
          {(hasEditActions || hasStateActions) &&
          (actions.archive || actions.unarchive || actions.cancel || actions.delete) ? (
            <DropdownMenuSeparator />
          ) : null}
          <EndItems goal={goal} actions={actions} handlers={handlers} testID={testID} />
        </DropdownMenuContent>
      </DropdownMenu>
      {sheet === "rename" ? (
        <GoalRenameSheet goal={goal} handlers={handlers} onClose={closeSheet} />
      ) : null}
      {retryChoice.sheet}
      {sheet === "settings" && goal.config ? (
        <GoalSettingsSheet
          serverId={serverId}
          goal={goal}
          config={goal.config}
          onClose={closeSheet}
        />
      ) : null}
    </>
  );
}

function EditItems({
  actions,
  priority,
  onRename,
  onEditSettings,
  testID,
}: {
  actions: GoalActions;
  priority: GoalPriority;
  onRename: () => void;
  onEditSettings: () => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {actions.rename ? (
        <DropdownMenuItem leading={renameIcon} onSelect={onRename} testID={`${testID}-rename`}>
          {t("goals.actions.rename")}
        </DropdownMenuItem>
      ) : null}
      {actions.priority ? (
        <DropdownMenuSubTrigger
          id={PRIORITY_PAGE_ID}
          leading={priorityIcon}
          value={t(`goals.priority.levels.${priority}`)}
          testID={`${testID}-priority-trigger`}
        >
          {t("goals.priority.label")}
        </DropdownMenuSubTrigger>
      ) : null}
      {actions.editSettings ? (
        <DropdownMenuItem
          leading={settingsIcon}
          onSelect={onEditSettings}
          testID={`${testID}-edit-settings`}
        >
          {t("goals.actions.editSettings")}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

interface ItemGroupProps {
  goal: Goal;
  actions: GoalActions;
  handlers: GoalActionHandlers;
  testID: string;
}

function StateItems({
  goal,
  actions,
  handlers,
  onRetry,
  testID,
}: ItemGroupProps & { onRetry: () => void }): ReactElement {
  const { t } = useTranslation();
  const handlePause = useCallback(() => handlers.pause(goal), [goal, handlers]);
  const handleResume = useCallback(() => handlers.resume(goal), [goal, handlers]);
  const handleDismiss = useCallback(() => handlers.dismiss(goal), [goal, handlers]);
  return (
    <>
      {actions.pause ? (
        <DropdownMenuItem leading={pauseIcon} onSelect={handlePause} testID={`${testID}-pause`}>
          {t("goals.detail.pause")}
        </DropdownMenuItem>
      ) : null}
      {actions.resume ? (
        <DropdownMenuItem leading={resumeIcon} onSelect={handleResume} testID={`${testID}-resume`}>
          {t("goals.detail.resume")}
        </DropdownMenuItem>
      ) : null}
      {actions.retry ? (
        <DropdownMenuItem leading={retryIcon} onSelect={onRetry} testID={`${testID}-retry`}>
          {t(
            goalRetryLabelKey({
              canRetryPlanning: actions.retryPlanning,
              canRetryMerge: actions.retryMerge,
            }),
          )}
        </DropdownMenuItem>
      ) : null}
      {actions.dismiss ? (
        <DropdownMenuItem
          leading={dismissIcon}
          onSelect={handleDismiss}
          testID={`${testID}-dismiss`}
        >
          {t("goals.detail.dismiss")}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function EndItems({ goal, actions, handlers, testID }: ItemGroupProps): ReactElement {
  const { t } = useTranslation();
  const handleArchive = useCallback(() => handlers.archive(goal), [goal, handlers]);
  const handleUnarchive = useCallback(() => handlers.unarchive(goal), [goal, handlers]);
  const handleCancel = useCallback(() => handlers.cancel(goal), [goal, handlers]);
  const handleDelete = useCallback(() => handlers.delete(goal), [goal, handlers]);
  return (
    <>
      {actions.archive ? (
        <DropdownMenuItem
          leading={archiveIcon}
          onSelect={handleArchive}
          testID={`${testID}-archive`}
        >
          {t("goals.actions.archive")}
        </DropdownMenuItem>
      ) : null}
      {actions.unarchive ? (
        <DropdownMenuItem
          leading={unarchiveIcon}
          onSelect={handleUnarchive}
          testID={`${testID}-unarchive`}
        >
          {t("goals.actions.unarchive")}
        </DropdownMenuItem>
      ) : null}
      {actions.cancel ? (
        <DropdownMenuItem leading={cancelIcon} onSelect={handleCancel} testID={`${testID}-cancel`}>
          {t("goals.detail.cancelGoal")}
        </DropdownMenuItem>
      ) : null}
      {actions.delete ? (
        <DropdownMenuItem leading={deleteIcon} onSelect={handleDelete} testID={`${testID}-delete`}>
          {t("goals.actions.delete")}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

function PriorityPage({
  goal,
  current,
  handlers,
  testID,
}: {
  goal: Goal;
  current: GoalPriority;
  handlers: GoalActionHandlers;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {GOAL_PRIORITIES.map((priority) => (
        <PriorityOption
          key={priority}
          goal={goal}
          priority={priority}
          selected={priority === current}
          handlers={handlers}
          testID={`${testID}-${priority}`}
        />
      ))}
      <DropdownMenuSeparator />
      {/* MenuHint is one line; this explanation needs to wrap inside the menu's width. */}
      <View style={styles.priorityHint}>
        <Text style={styles.priorityHintText}>{t("goals.priority.hint")}</Text>
      </View>
    </>
  );
}

function PriorityOption({
  goal,
  priority,
  selected,
  handlers,
  testID,
}: {
  goal: Goal;
  priority: GoalPriority;
  selected: boolean;
  handlers: GoalActionHandlers;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    if (!selected) {
      handlers.setPriority(goal, priority);
    }
  }, [goal, handlers, priority, selected]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} testID={testID}>
      {t(`goals.priority.levels.${priority}`)}
    </DropdownMenuItem>
  );
}

/** Mount only while open, so every open starts from the goal's current title. */
function GoalRenameSheet({
  goal,
  handlers,
  onClose,
}: {
  goal: Goal;
  handlers: GoalActionHandlers;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [title, setTitle] = useState(goal.title);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = title.trim();
  const isEmpty = trimmed.length === 0;
  const canSave = !isEmpty && trimmed !== goal.title && !handlers.isRenaming;
  const handleChange = useCallback((value: string) => {
    setTitle(value);
    setTouched(true);
    setError(null);
  }, []);
  const handleSave = useCallback(() => {
    if (!canSave) {
      return;
    }
    handlers
      .rename(goal, trimmed)
      .then(onClose)
      .catch((cause: unknown) => setError(toErrorMessage(cause)));
  }, [canSave, goal, handlers, onClose, trimmed]);
  const header = useMemo<SheetHeader>(() => ({ title: t("goals.actions.renameTitle") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSave}
          disabled={!canSave}
          loading={handlers.isRenaming}
          testID="goal-rename-save"
        >
          {t("goals.actions.renameSave")}
        </Button>
      </View>
    ),
    [canSave, handleSave, handlers.isRenaming, onClose, t],
  );
  const fieldError = touched && isEmpty ? t("goals.actions.renameRequired") : error;

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-rename-sheet"
    >
      <Field label={t("goals.actions.renameLabel")} error={fieldError}>
        <FormTextInput
          size={size}
          testID="goal-rename-input"
          accessibilityLabel={t("goals.actions.renameLabel")}
          initialValue={goal.title}
          onChangeText={handleChange}
          onSubmitEditing={handleSave}
          returnKeyType="done"
          autoFocus
        />
      </Field>
    </AdaptiveModalSheet>
  );
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 2,
    borderRadius: 4,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  // The popover sizes to its widest row, so the explanation wraps at a menu's width there.
  priorityHint: {
    maxWidth: { xs: "100%", md: 240 },
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  priorityHintText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));
