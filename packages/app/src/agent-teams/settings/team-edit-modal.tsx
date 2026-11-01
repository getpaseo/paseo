import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentTeamConfigWire } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildRoleModeOptions,
  buildRoleModelOptions,
  parseRoleAgent,
  type TeamFormModel,
  type TeamFormOption,
  type TeamRoleDraft,
  type TeamRoleIsolation,
  type TeamRoleIssues,
} from "./team-form-model";
import { useTeamFormInputs, useTeamFormModel, useTeamFormState } from "./use-team-form";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";

const ThemedPlus = withUnistyles(Plus);
const ThemedTrash2 = withUnistyles(Trash2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const addIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;

export interface TeamEditSaveValue {
  originalName: string | null;
  name: string;
  team: AgentTeamConfigWire;
}

export interface TeamEditModalProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  teamName?: string;
  team?: AgentTeamConfigWire;
  existingTeamNames: readonly string[];
  onClose: () => void;
  onSave: (value: TeamEditSaveValue) => Promise<void>;
}

function openKey(props: TeamEditModalProps): string {
  return props.mode === "edit" ? `edit:${props.teamName ?? ""}` : "create";
}

/**
 * Create and edit never share a mounted body: it is keyed on mode plus team
 * name, so every open seeds a fresh form model from that record.
 */
export function TeamEditModal(props: TeamEditModalProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<TeamEditModalProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) return;
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) setSheetVisible(false);
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) dismissedProps.onClose();
  }, []);

  if (!renderedProps) return null;

  return (
    <OpenTeamEditModal
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function toSelectOptions(options: TeamFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

function OpenTeamEditModal({
  serverId,
  visible,
  mode,
  teamName,
  team,
  existingTeamNames,
  onClose,
  onDismiss,
  onSave,
}: TeamEditModalProps & { onDismiss: () => void }): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const model = useTeamFormModel({
    mode,
    ...(teamName !== undefined ? { teamName } : {}),
    ...(team ? { team } : {}),
    existingTeamNames,
  });
  const state = useTeamFormState(model);
  useTeamFormInputs({ serverId, model });

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("settings.host.agentTeams.editTeamTitle")
          : t("settings.host.agentTeams.addTeamTitle"),
    }),
    [mode, t],
  );
  const agentOptions = useMemo(() => toSelectOptions(state.agentOptions), [state.agentOptions]);

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) return;
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave({ originalName: model.getState().originalName, ...value });
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onSave]);
  const handleSavePress = useCallback(() => void handleSave(), [handleSave]);
  const handleCancel = useCallback(() => {
    if (!state.isSubmitting) onClose();
  }, [onClose, state.isSubmitting]);

  const nameError =
    state.nameIssue === "duplicate" ? t("settings.host.agentTeams.nameDuplicate") : null;

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      onClose={handleCancel}
      onDismiss={onDismiss}
      desktopMaxWidth={560}
      testID="team-edit-modal"
    >
      <View style={styles.body}>
        <Field
          label={t("settings.host.agentTeams.nameLabel")}
          error={nameError}
          testID="team-name-field"
        >
          <FormTextInput
            initialValue={teamName ?? ""}
            onChangeText={model.setName}
            placeholder={t("settings.host.agentTeams.namePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.host.agentTeams.nameLabel")}
            testID="team-name-input"
          />
        </Field>

        <Field
          label={t("settings.host.agentTeams.descriptionLabel")}
          testID="team-description-field"
        >
          <FormTextInput
            initialValue={team?.description ?? ""}
            onChangeText={model.setDescription}
            placeholder={t("settings.host.agentTeams.descriptionPlaceholder")}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.host.agentTeams.descriptionLabel")}
            testID="team-description-input"
          />
        </Field>

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>{t("settings.host.agentTeams.peerMessagingLabel")}</Text>
          <Switch
            value={state.peerMessaging}
            onValueChange={model.setPeerMessaging}
            disabled={state.isSubmitting}
            accessibilityLabel={t("settings.host.agentTeams.peerMessagingLabel")}
            testID="team-peer-messaging-switch"
          />
        </View>

        <View style={styles.rolesHeader}>
          <Text style={styles.rolesTitle}>{t("settings.host.agentTeams.rolesLabel")}</Text>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={addIcon}
            onPress={model.addRole}
            disabled={state.isSubmitting}
            testID="team-add-role-button"
          >
            {t("settings.host.agentTeams.addRole")}
          </Button>
        </View>

        {state.roles.map((role) => (
          <TeamRoleCard
            key={role.key}
            role={role}
            issues={state.roleIssues[role.key] ?? null}
            entries={state.entries}
            agentOptions={agentOptions}
            canRemove={state.roles.length > 1}
            disabled={state.isSubmitting}
            size={controlSize}
            model={model}
          />
        ))}

        {state.submitError ? (
          <Text style={styles.submitError} testID="team-submit-error">
            {state.submitError}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="team-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            testID="team-save-button"
          >
            {state.isSubmitting
              ? t("settings.host.agentTeams.saving")
              : t("settings.host.agentTeams.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function TeamRoleCard({
  role,
  issues,
  entries,
  agentOptions,
  canRemove,
  disabled,
  size,
  model,
}: {
  role: TeamRoleDraft;
  issues: TeamRoleIssues | null;
  entries: readonly ProviderSnapshotEntry[];
  agentOptions: SelectFieldOption<string>[];
  canRemove: boolean;
  disabled: boolean;
  size: FieldControlSize;
  model: TeamFormModel;
}): ReactElement {
  const { t } = useTranslation();
  const { key } = role;
  const isProvider = parseRoleAgent(role.agent)?.kind === "provider";
  const modelOptions = useMemo(
    () => toSelectOptions(buildRoleModelOptions(entries, role.agent)),
    [entries, role.agent],
  );
  const modeOptions = useMemo(
    () => toSelectOptions(buildRoleModeOptions(entries, role.agent)),
    [entries, role.agent],
  );
  const isolationOptions = useMemo<SegmentedControlOption<TeamRoleIsolation>[]>(
    () => [
      { value: "", label: t("settings.host.agentTeams.isolationDefault") },
      { value: "local", label: t("settings.host.agentTeams.isolationLocal") },
      { value: "worktree", label: t("settings.host.agentTeams.isolationWorktree") },
    ],
    [t],
  );

  const handleName = useCallback((value: string) => model.setRoleName(key, value), [key, model]);
  const handleDescription = useCallback(
    (value: string) => model.setRoleDescription(key, value),
    [key, model],
  );
  const handleAgent = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setRoleAgent(key, value, display),
    [key, model],
  );
  const handleModel = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setRoleModel(key, value, display),
    [key, model],
  );
  const handleMode = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setRoleMode(key, value, display),
    [key, model],
  );
  const handleIsolation = useCallback(
    (value: TeamRoleIsolation) => model.setRoleIsolation(key, value),
    [key, model],
  );
  const handleRemove = useCallback(() => model.removeRole(key), [key, model]);

  const nameError =
    issues?.name === "duplicate" ? t("settings.host.agentTeams.roleNameDuplicate") : null;

  return (
    <View style={styles.roleCard} testID={`team-role-card-${key}`}>
      <View style={styles.roleHeader}>
        <View style={styles.roleNameField}>
          <Field
            label={t("settings.host.agentTeams.roleNameLabel")}
            error={nameError}
            testID={`team-role-name-field-${key}`}
          >
            <FormTextInput
              initialValue={role.name}
              onChangeText={handleName}
              placeholder={t("settings.host.agentTeams.roleNamePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              size={size}
              accessibilityLabel={t("settings.host.agentTeams.roleNameLabel")}
              testID={`team-role-name-input-${key}`}
            />
          </Field>
        </View>
        {canRemove ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={removeIcon}
            onPress={handleRemove}
            disabled={disabled}
            accessibilityLabel={t("settings.host.agentTeams.removeRole")}
            testID={`team-role-remove-${key}`}
          />
        ) : null}
      </View>

      <Field
        label={t("settings.host.agentTeams.roleDescriptionLabel")}
        testID={`team-role-description-field-${key}`}
      >
        <FormTextInput
          initialValue={role.description}
          onChangeText={handleDescription}
          placeholder={t("settings.host.agentTeams.roleDescriptionPlaceholder")}
          editable={!disabled}
          size={size}
          accessibilityLabel={t("settings.host.agentTeams.roleDescriptionLabel")}
          testID={`team-role-description-input-${key}`}
        />
      </Field>

      <SelectField
        label={t("settings.host.agentTeams.agentLabel")}
        value={role.agent || null}
        selectedDisplay={role.agentDisplay}
        options={agentOptions}
        onChange={handleAgent}
        placeholder={t("settings.host.agentTeams.agentPlaceholder")}
        emptyText={t("settings.host.agentTeams.noAgents")}
        disabled={disabled}
        searchable={agentOptions.length > 6}
        title={t("settings.host.agentTeams.agentLabel")}
        size={size}
        testID={`team-role-agent-field-${key}`}
        triggerTestID={`team-role-agent-trigger-${key}`}
      />

      {isProvider && modelOptions.length > 0 ? (
        <SelectField
          label={t("settings.host.agentTeams.modelLabel")}
          value={role.model || null}
          selectedDisplay={role.modelDisplay}
          options={modelOptions}
          onChange={handleModel}
          placeholder={t("settings.host.agentTeams.modelLabel")}
          emptyText={t("settings.host.agentTeams.noModels")}
          disabled={disabled}
          searchable={modelOptions.length > 6}
          title={t("settings.host.agentTeams.modelLabel")}
          size={size}
          testID={`team-role-model-field-${key}`}
          triggerTestID={`team-role-model-trigger-${key}`}
        />
      ) : null}

      {isProvider && modeOptions.length > 0 ? (
        <SelectField
          label={t("settings.host.agentTeams.modeLabel")}
          value={role.modeId || null}
          selectedDisplay={role.modeDisplay}
          options={modeOptions}
          onChange={handleMode}
          placeholder={t("settings.host.agentTeams.modeLabel")}
          emptyText={t("settings.host.agentTeams.noModes")}
          disabled={disabled}
          searchable={modeOptions.length > 6}
          title={t("settings.host.agentTeams.modeLabel")}
          size={size}
          testID={`team-role-mode-field-${key}`}
          triggerTestID={`team-role-mode-trigger-${key}`}
        />
      ) : null}

      <Field
        label={t("settings.host.agentTeams.isolationLabel")}
        testID={`team-role-isolation-field-${key}`}
      >
        <SegmentedControl
          options={isolationOptions}
          value={role.isolation}
          onValueChange={handleIsolation}
          size={size}
          testID={`team-role-isolation-${key}`}
        />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  switchLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rolesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rolesTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  roleCard: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  roleHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  roleNameField: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
