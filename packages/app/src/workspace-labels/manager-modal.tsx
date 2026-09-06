import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { Pencil } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createWorkspaceLabelManagerModel,
  useWorkspaceLabelProjection,
  workspaceLabels,
  type WorkspaceLabelManagerDraft,
} from "@/workspace-labels";
import { WorkspaceLabelDot, WorkspaceLabelSwatchRow } from "./swatch";
import { useTranslation } from "react-i18next";

/** The size the host pill's own glyphs use, so the row's trailing mark matches the controls above it. */
const EDIT_ICON_SIZE = 14;

/** Grows the pencil to a 44pt target without moving it off the trailing rail. */
const EDIT_HIT_SLOP = (44 - EDIT_ICON_SIZE) / 2;

const ThemedPencil = withUnistyles(Pencil);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The whole label catalog of one host, and editing any one of them.
 *
 * Two views, one sheet: the list, and the edit view the pencil opens. The edit view is reached
 * the way every other sheet reaches a second page — the header's back arrow returns from it —
 * because a label row is a label, not a button that swaps the surface under you.
 */
export function WorkspaceLabelManagerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const snapshots = useMemo(
    () => Object.fromEntries(labelHosts.map((host) => [host.serverId, host])),
    [labelHosts],
  );
  const [model] = useState(() =>
    createWorkspaceLabelManagerModel({
      update: (input) => workspaceLabels.update(input),
      inspectDelete: (input) => workspaceLabels.inspectDelete(input),
      delete: (input) => workspaceLabels.delete(input),
    }),
  );

  useEffect(() => {
    // Closing ends the edit, so reopening lands on the list rather than on whatever was half
    // typed a session ago.
    if (!visible) {
      model.reset();
      return;
    }
    model.syncHosts(
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label || host.serverId,
        status: snapshots[host.serverId]?.status ?? "offline",
        labels: snapshots[host.serverId]?.labels ?? [],
        error: snapshots[host.serverId]?.error,
      })),
    );
  }, [hosts, model, snapshots, visible]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  const draft = state.draft;
  const editing = state.editing;
  const disabled = state.host?.status !== "online" || state.pending;

  const selectHost = useCallback((serverId: string) => model.selectHost(serverId), [model]);
  const setQuery = useCallback((value: string) => model.setQuery(value), [model]);
  const edit = useCallback((label: WorkspaceLabelDefinition) => model.edit(label), [model]);
  const cancelEdit = useCallback(() => model.cancelEdit(), [model]);
  const setDraftName = useCallback((value: string) => model.setDraftName(value), [model]);
  const setDraftColor = useCallback(
    (color: WorkspaceLabelColor) => model.setDraftColor(color),
    [model],
  );
  const save = useCallback(() => {
    void model.save();
  }, [model]);
  const remove = useCallback((): void => {
    if (!editing) return;
    void model.delete((affected) =>
      confirmDialog({
        title: t("workspaceLabels.manage.deleteTitle", { name: editing.name }),
        message: t("workspaceLabels.manage.deleteMessage", { count: affected }),
        confirmLabel: t("workspaceLabels.manage.delete"),
        destructive: true,
      }),
    );
  }, [editing, model, t]);

  const isEditing = draft !== null;
  // Search belongs to the sheet's header, where it spans the header's own rails and needs no
  // layout from this caller. `resetKey` empties the uncontrolled field on the same event that
  // clears the model's query, so the box and the list never disagree about what is filtered.
  const header = useMemo<SheetHeader>(
    () =>
      isEditing
        ? {
            title: t("workspaceLabels.manage.edit"),
            back: { onPress: cancelEdit },
          }
        : {
            title: t("workspaceLabels.manage.title"),
            search: {
              onChange: setQuery,
              resetKey: Number(visible),
              placeholder: t("workspaceLabels.manage.search"),
              testID: "workspace-label-manager-search",
            },
          },
    [cancelEdit, isEditing, setQuery, t, visible],
  );
  const footer = useMemo(
    () =>
      isEditing ? (
        <View style={styles.footer}>
          <Button
            // Red belongs to the confirm dialog, not to the surface that opens it — docs/design.md.
            variant="outline"
            size="md"
            disabled={disabled}
            onPress={remove}
            testID="workspace-label-manager-delete"
          >
            {t("workspaceLabels.manage.delete")}
          </Button>
          <Button
            size="md"
            style={styles.saveButton}
            disabled={disabled || !state.dirty}
            loading={state.pending}
            onPress={save}
            testID="workspace-label-manager-save"
          >
            {t("workspaceLabels.manage.save")}
          </Button>
        </View>
      ) : undefined,
    [disabled, isEditing, remove, save, state.dirty, state.pending, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      footer={footer}
      // Bound the compact scroller to the live snap height, so the edit view's footer stays on
      // screen instead of being pushed past the bottom of the sheet.
      sizeContentToCurrentSnapPoint
      testID="workspace-label-manager"
    >
      {draft && editing ? (
        <WorkspaceLabelEditView
          draft={draft}
          disabled={disabled}
          error={state.error}
          onChangeName={setDraftName}
          onChangeColor={setDraftColor}
          onSubmit={save}
        />
      ) : (
        <>
          {hosts.length > 1 ? (
            <HostFilter
              hosts={hosts}
              selectedHost={state.serverId}
              onSelectHost={selectHost}
              includeAllHost={false}
              triggerTestID="workspace-label-manager-host"
              hostOptionTestID={managerHostOptionTestID}
            />
          ) : null}
          <View style={styles.list}>
            {state.labels.map((label) => (
              <WorkspaceLabelManagerRow
                key={workspaceLabelKey(label.name)}
                label={label}
                disabled={disabled}
                onEdit={edit}
              />
            ))}
            {state.labels.length === 0 ? (
              <Text style={styles.muted}>{t("workspaceLabels.manage.empty")}</Text>
            ) : null}
          </View>
          {state.host?.status === "offline" ? (
            <Text style={styles.muted}>{t("workspaceLabels.manage.offline")}</Text>
          ) : null}
          {state.host?.status === "unsupported" ? (
            <Text style={styles.muted}>{t("workspaceLabels.manage.updateHost")}</Text>
          ) : null}
          {(state.error ?? state.host?.error) ? (
            <Text style={styles.error} testID="workspace-label-manager-error">
              {state.error ?? state.host?.error}
            </Text>
          ) : null}
        </>
      )}
    </AdaptiveModalSheet>
  );
}

const managerHostOptionTestID = (serverId: string) => `workspace-label-manager-host-${serverId}`;

/**
 * One label: its colour, its name, and the pencil that opens it.
 *
 * Hover lives on the plain outer `View` and press on the inner `Pressable`, which is the one
 * shape that survives a pressable inside a hover target (docs/hover.md). The pencil fades rather
 * than mounts, so revealing it cannot move the row out from under the pointer.
 */
function WorkspaceLabelManagerRow({
  label,
  disabled,
  onEdit,
}: {
  label: WorkspaceLabelDefinition;
  disabled: boolean;
  onEdit: (label: WorkspaceLabelDefinition) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const edit = useCallback(() => onEdit(label), [label, onEdit]);
  const revealed = isHovered || isNative || isCompact;
  const editStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.rowEdit,
      !revealed && styles.rowEditHidden,
      pressed && styles.rowEditPressed,
    ],
    [revealed],
  );

  return (
    <View
      style={styles.row}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`workspace-label-manager-label-${label.name}`}
    >
      <WorkspaceLabelDot color={label.color} />
      <Text style={styles.rowName} numberOfLines={1}>
        {label.name}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("workspaceLabels.manage.editLabel", { name: label.name })}
        disabled={disabled}
        hitSlop={EDIT_HIT_SLOP}
        onPress={edit}
        pointerEvents={revealed ? "auto" : "none"}
        style={editStyle}
        testID={`workspace-label-manager-edit-${label.name}`}
      >
        <ThemedPencil size={EDIT_ICON_SIZE} uniProps={mutedMapping} />
      </Pressable>
    </View>
  );
}

/**
 * A label's name and colour, changed together and committed once by the footer's Save.
 *
 * Picking a colour picks a colour — nothing leaves for the host until Save, so a failure has one
 * thing to report and the draft is still exactly what was typed.
 */
function WorkspaceLabelEditView({
  draft,
  disabled,
  error,
  onChangeName,
  onChangeColor,
  onSubmit,
}: {
  draft: WorkspaceLabelManagerDraft;
  disabled: boolean;
  error: string | null;
  onChangeName: (value: string) => void;
  onChangeColor: (color: WorkspaceLabelColor) => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  return (
    <>
      <Field label={t("workspaceLabels.manage.name")}>
        <FormTextInput
          size={size}
          initialValue={draft.name}
          resetKey={draft.name}
          onChangeText={onChangeName}
          onSubmitEditing={onSubmit}
          editable={!disabled}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("workspaceLabels.manage.name")}
          testID="workspace-label-manager-name"
        />
      </Field>
      <Field label={t("workspaceLabels.manage.color")}>
        <WorkspaceLabelSwatchRow
          value={draft.color}
          onChange={onChangeColor}
          disabled={disabled}
          testID="workspace-label-manager-colors"
        />
      </Field>
      {error ? (
        <Text style={styles.error} testID="workspace-label-manager-error">
          {error}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  // Fixed height so the pencil appearing cannot resize the row under the pointer. The dot leads
  // at the content inset and the pencil ends on it; nothing here indents, so the list holds one
  // rail down its whole length.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowEdit: {
    // The glyph is the whole control — its 44pt target comes from hitSlop, which grows outward
    // and leaves the trailing rail where it is.
    alignItems: "center",
    justifyContent: "center",
  },
  rowEditHidden: {
    opacity: 0,
  },
  rowEditPressed: {
    opacity: 0.6,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  saveButton: {
    minWidth: 112,
  },
}));
