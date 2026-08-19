import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import { toErrorMessage } from "@/utils/error-messages";
import { AgentProfileAppearanceField } from "./agent-profile-appearance-field";
import type {
  AgentProfileFormModel,
  AgentProfileFormOption,
  AgentProfileValue,
} from "../internal/profile-form-model";
import {
  useAgentProfileFormCatalog,
  useAgentProfileFormFeatures,
} from "../internal/use-profile-form-inputs";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "../internal/use-profile-form-model";

export interface AgentProfileEditModalProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  profile?: AgentProfile;
  onClose: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
}

/**
 * Only reachable before the catalog lands. Every select is seeded to a concrete
 * id as soon as one exists, and none of them offer an "unset" row.
 */
const UNSET_VALUE = "";

function openKey(props: AgentProfileEditModalProps): string {
  return props.mode === "edit" ? `edit:${props.profile?.id ?? ""}` : "create";
}

/**
 * Create and edit never share a mounted instance: the body is keyed on mode plus
 * profile id, so every open constructs a form model seeded from that record.
 */
export function AgentProfileEditModal(props: AgentProfileEditModalProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<AgentProfileEditModalProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
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
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenAgentProfileEditModal
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

function OpenAgentProfileEditModal({
  serverId,
  visible,
  mode,
  profile,
  onClose,
  onDismiss,
  onSave,
}: AgentProfileEditModalProps & { onDismiss: () => void }): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const snapshot = useMemo(() => ({ mode, ...(profile ? { profile } : {}) }), [mode, profile]);
  const model = useAgentProfileFormModel(snapshot);
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId, model });
  useAgentProfileFormFeatures({ serverId, model, state });

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("settings.host.agentProfiles.editProfileTitle")
          : t("settings.host.agentProfiles.addProfileTitle"),
    }),
    [mode, t],
  );

  const providerOptions = useMemo(
    () => toSelectOptions(state.providerOptions),
    [state.providerOptions],
  );
  const modelOptions = useMemo(() => toSelectOptions(state.modelOptions), [state.modelOptions]);
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );

  const handleAppearanceChange = useCallback(
    (value: { icon: string; color: string }) => model.setAppearance(value),
    [model],
  );
  const handleProviderChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setProvider(value, display),
    [model],
  );
  const handleModelChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setModel(value, value ? display : null),
    [model],
  );
  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );
  const handleThinkingChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) {
      return;
    }
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave(value);
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onSave]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleCancel = useCallback(() => {
    if (state.isSubmitting) {
      return;
    }
    onClose();
  }, [onClose, state.isSubmitting]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      onClose={handleCancel}
      onDismiss={onDismiss}
      desktopMaxWidth={520}
      testID="agent-profile-edit-modal"
    >
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <View style={styles.iconField}>
            <AgentProfileAppearanceField
              label={t("settings.host.agentProfiles.iconLabel")}
              icon={state.icon}
              color={state.color}
              onChange={handleAppearanceChange}
              disabled={state.isSubmitting}
              size={controlSize}
              testID="agent-profile-icon-field"
              triggerTestID="agent-profile-icon-trigger"
            />
          </View>
          <View style={styles.nameField}>
            <Field
              label={t("settings.host.agentProfiles.nameLabel")}
              testID="agent-profile-name-field"
            >
              <FormTextInput
                initialValue={profile?.name ?? ""}
                onChangeText={model.setName}
                placeholder={t("settings.host.agentProfiles.namePlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!state.isSubmitting}
                size={controlSize}
                accessibilityLabel={t("settings.host.agentProfiles.nameLabel")}
                testID="agent-profile-name-input"
              />
            </Field>
          </View>
        </View>

        <SelectField
          label={t("settings.host.agentProfiles.providerLabel")}
          value={state.provider || null}
          selectedDisplay={state.providerDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          placeholder={t("settings.host.agentProfiles.providerPlaceholder")}
          emptyText={t("settings.host.agentProfiles.noProviders")}
          loading={state.catalogResolution !== "complete"}
          disabled={state.isSubmitting}
          searchable={providerOptions.length > 6}
          title={t("settings.host.agentProfiles.providerLabel")}
          size={controlSize}
          testID="agent-profile-provider-field"
          triggerTestID="agent-profile-provider-trigger"
        />

        {state.disclosure.showModelField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modelLabel")}
            value={state.modelId || UNSET_VALUE}
            selectedDisplay={state.modelDisplay}
            options={modelOptions}
            onChange={handleModelChange}
            placeholder={t("settings.host.agentProfiles.modelLabel")}
            emptyText={t("settings.host.agentProfiles.noModels")}
            disabled={state.isSubmitting}
            searchable={modelOptions.length > 6}
            title={t("settings.host.agentProfiles.modelLabel")}
            size={controlSize}
            testID="agent-profile-model-field"
            triggerTestID="agent-profile-model-trigger"
          />
        ) : null}

        {state.disclosure.showModeField ? (
          <SelectField
            label={t("settings.host.agentProfiles.modeLabel")}
            value={state.modeId || UNSET_VALUE}
            selectedDisplay={state.modeDisplay}
            options={modeOptions}
            onChange={handleModeChange}
            placeholder={t("settings.host.agentProfiles.modeLabel")}
            emptyText={t("settings.host.agentProfiles.noModes")}
            disabled={state.isSubmitting}
            searchable={modeOptions.length > 6}
            title={t("settings.host.agentProfiles.modeLabel")}
            size={controlSize}
            testID="agent-profile-mode-field"
            triggerTestID="agent-profile-mode-trigger"
          />
        ) : null}

        {state.disclosure.showThinkingField ? (
          <SelectField
            label={t("settings.host.agentProfiles.thinkingLabel")}
            value={state.thinkingOptionId || UNSET_VALUE}
            selectedDisplay={state.thinkingDisplay}
            options={thinkingOptions}
            onChange={handleThinkingChange}
            placeholder={t("settings.host.agentProfiles.thinkingLabel")}
            emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
            disabled={state.isSubmitting}
            searchable={thinkingOptions.length > 6}
            title={t("settings.host.agentProfiles.thinkingLabel")}
            size={controlSize}
            testID="agent-profile-thinking-field"
            triggerTestID="agent-profile-thinking-trigger"
          />
        ) : null}

        {state.disclosure.showFeaturesField ? (
          <Field
            label={t("settings.host.agentProfiles.featuresLabel")}
            testID="agent-profile-features-field"
          >
            <View style={styles.featureCard} testID="agent-profile-features-card">
              {state.features.map((feature, index) => (
                <AgentProfileFeatureRow
                  key={feature.id}
                  feature={feature}
                  isFirst={index === 0}
                  disabled={state.isSubmitting}
                  size={controlSize}
                  model={model}
                />
              ))}
            </View>
          </Field>
        ) : null}

        <Field
          label={t("settings.host.agentProfiles.notesLabel")}
          hint={t("settings.host.agentProfiles.notesHint")}
          testID="agent-profile-notes-field"
        >
          <FormTextInput
            initialValue={profile?.notes ?? ""}
            onChangeText={model.setNotes}
            placeholder={t("settings.host.agentProfiles.notesPlaceholder")}
            multiline
            numberOfLines={4}
            style={styles.notesInput}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("settings.host.agentProfiles.notesLabel")}
            testID="agent-profile-notes-input"
          />
        </Field>

        {state.submitError ? (
          <Text style={styles.submitError} testID="agent-profile-submit-error">
            {state.submitError}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="agent-profile-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            testID="agent-profile-save-button"
          >
            {state.isSubmitting
              ? t("settings.host.agentProfiles.saving")
              : t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function AgentProfileFeatureRow({
  feature,
  isFirst,
  disabled,
  size,
  model,
}: {
  feature: AgentFeature;
  isFirst: boolean;
  disabled: boolean;
  size: FieldControlSize;
  model: AgentProfileFormModel;
}): ReactElement {
  const rowStyle = useMemo(
    () => [styles.featureRow, isFirst ? null : styles.featureRowBorder],
    [isFirst],
  );
  const handleToggle = useCallback(
    (value: boolean) => model.setFeatureValue(feature.id, value),
    [feature.id, model],
  );
  const handleSelect = useCallback(
    (value: string) => model.setFeatureValue(feature.id, value),
    [feature.id, model],
  );
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({
            id: option.id,
            value: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            testID: `agent-profile-feature-option-${feature.id}-${option.id}`,
          }))
        : [],
    [feature],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (feature.type !== "select" || !feature.value) {
      return null;
    }
    const option = feature.options.find((candidate) => candidate.id === feature.value);
    return { label: option?.label ?? feature.value };
  }, [feature]);

  if (feature.type === "select") {
    return (
      <View style={rowStyle} testID={`agent-profile-feature-row-${feature.id}`}>
        <SelectField
          label={feature.label}
          value={feature.value}
          selectedDisplay={selectedDisplay}
          options={selectOptions}
          onChange={handleSelect}
          placeholder={feature.label}
          emptyText={feature.label}
          disabled={disabled}
          {...(feature.description ? { hint: feature.description } : {})}
          title={feature.label}
          size={size}
          testID={`agent-profile-feature-field-${feature.id}`}
          triggerTestID={`agent-profile-feature-trigger-${feature.id}`}
        />
      </View>
    );
  }

  return (
    <View style={rowStyle} testID={`agent-profile-feature-row-${feature.id}`}>
      <View style={styles.featureMeta}>
        <Text style={styles.featureLabel} numberOfLines={1}>
          {feature.label}
        </Text>
        {feature.description ? (
          <Text style={styles.featureDescription} numberOfLines={2}>
            {feature.description}
          </Text>
        ) : null}
      </View>
      <Switch
        value={feature.value === true}
        onValueChange={handleToggle}
        disabled={disabled}
        accessibilityLabel={feature.label}
        testID={`agent-profile-feature-switch-${feature.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  // No width: the trigger is a glyph and a chevron, so it sizes to them.
  iconField: {
    flexShrink: 0,
  },
  nameField: {
    flex: 1,
  },
  featureCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  featureRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  featureMeta: {
    flex: 1,
    gap: theme.spacing[1],
  },
  featureLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  featureDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  notesInput: {
    minHeight: 88,
    textAlignVertical: "top",
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
