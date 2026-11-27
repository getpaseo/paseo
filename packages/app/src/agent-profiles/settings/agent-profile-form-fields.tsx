import { useCallback, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  AgentOptionControl,
  AgentProvider,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";
import { readSelectOption, readToggleOption } from "@/agent-controls/option-controls";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { ICON_SIZE } from "@/styles/theme";
import { AgentProfileGlyph } from "../internal/agent-profile-glyph";
import type {
  AgentProfileFormModel,
  AgentProfileFormOption,
  AgentProfileFormState,
} from "../internal/profile-form-model";
import { AgentProfileIconButton } from "./agent-profile-appearance-field";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const UNSET_VALUE = "";

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID,
  }));
}

function canUseSegmentedThinking(options: readonly AgentProfileFormOption[]): boolean {
  return (
    options.length >= 2 &&
    options.length <= 4 &&
    options.every((option) => option.label.trim().length <= 12)
  );
}

export interface AgentProfileFormFieldsProps {
  serverId: string;
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  controlSize?: ControlSize;
  /** Embeds the icon+color picker beside the Name input (used in sheets; drawer places it in its hero). */
  showInlineIcon?: boolean;
  /** Collapses Mode, Thinking, Notes, and Options behind a SettingsCollapsibleRow until expanded. */
  collapsibleDefaults?: boolean;
}

function ThinkingField({
  state,
  controlSize,
  onSelectChange,
  onSegmentChange,
}: {
  state: AgentProfileFormState;
  controlSize: ControlSize;
  onSelectChange: (value: string, display: SelectFieldDisplay) => void;
  onSegmentChange: (value: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );
  const segmentedThinkingOptions = useMemo<SegmentedControlOption<string>[]>(
    () =>
      state.thinkingOptions.map((option) => ({
        value: option.value,
        label: option.label,
        disabled: state.isSubmitting,
        testID: option.testID,
      })),
    [state.isSubmitting, state.thinkingOptions],
  );
  if (!state.disclosure.showThinkingField) {
    return null;
  }
  if (canUseSegmentedThinking(state.thinkingOptions)) {
    return (
      <Field
        label={t("settings.host.agentProfiles.thinkingLabel")}
        testID="agent-profile-thinking-field"
      >
        <SegmentedControl
          options={segmentedThinkingOptions}
          value={state.thinkingOptionId || null}
          onValueChange={onSegmentChange}
          size={controlSize}
          testID="agent-profile-thinking-trigger"
        />
      </Field>
    );
  }
  return (
    <SelectField
      label={t("settings.host.agentProfiles.thinkingLabel")}
      value={state.thinkingOptionId || UNSET_VALUE}
      selectedDisplay={state.thinkingDisplay}
      options={thinkingOptions}
      onChange={onSelectChange}
      placeholder={t("settings.host.agentProfiles.thinkingLabel")}
      emptyText={t("settings.host.agentProfiles.noThinkingOptions")}
      disabled={state.isSubmitting}
      searchable={thinkingOptions.length > 6}
      title={t("settings.host.agentProfiles.thinkingLabel")}
      size={controlSize}
      testID="agent-profile-thinking-field"
      triggerTestID="agent-profile-thinking-trigger"
    />
  );
}

function AgentProfileControlRow({
  control,
  options,
  disabled,
  model,
}: {
  control: AgentOptionControl;
  options: ProviderOptions;
  disabled: boolean;
  model: AgentProfileFormModel;
}): ReactElement {
  const handleToggle = useCallback(
    (value: boolean) => model.setOption(control.key, value),
    [control.key, model],
  );
  const handleSelect = useCallback(
    (value: string) => model.setOption(control.key, value),
    [control.key, model],
  );
  const selectOptions = useMemo(
    () =>
      control.type === "select"
        ? control.choices.map((choice) => ({ label: choice.label, value: choice.value }))
        : [],
    [control],
  );

  if (control.type === "select") {
    const selectedValue = readSelectOption(control, options) ?? control.choices[0]?.value ?? "";
    return (
      <SettingsSelect
        label={control.label}
        hint={control.description}
        value={selectedValue}
        options={selectOptions}
        onValueChange={handleSelect}
        disabled={disabled}
        testID={`agent-profile-feature-row-${control.key}`}
      />
    );
  }

  return (
    <SettingsSwitch
      label={control.label}
      hint={control.description}
      value={readToggleOption(control, options)}
      onValueChange={handleToggle}
      disabled={disabled}
      testID={`agent-profile-feature-row-${control.key}`}
    />
  );
}

function AgentProfileAdvancedFields({
  model,
  state,
  controlSize,
  onModeChange,
  onThinkingSelectChange,
  onThinkingSegmentChange,
}: {
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  controlSize: ControlSize;
  onModeChange: (value: string, display: SelectFieldDisplay) => void;
  onThinkingSelectChange: (value: string, display: SelectFieldDisplay) => void;
  onThinkingSegmentChange: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const providerOptionsTitle = state.providerDisplay?.label
    ? t("settings.host.agentProfiles.providerOptionsLabel", {
        provider: state.providerDisplay.label,
      })
    : t("settings.host.agentProfiles.featuresLabel");
  const optionsPendingSpinner = useMemo(
    () =>
      state.controlsPending ? (
        <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
      ) : null,
    [state.controlsPending],
  );

  return (
    <>
      {state.disclosure.showModeField ? (
        <SelectField
          label={t("settings.host.agentProfiles.modeLabel")}
          value={state.modeId || UNSET_VALUE}
          selectedDisplay={state.modeDisplay}
          options={modeOptions}
          onChange={onModeChange}
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

      <ThinkingField
        state={state}
        controlSize={controlSize}
        onSelectChange={onThinkingSelectChange}
        onSegmentChange={onThinkingSegmentChange}
      />

      <Field
        label={t("settings.host.agentProfiles.systemPromptLabel")}
        hint={t("settings.host.agentProfiles.systemPromptHint")}
        testID="agent-profile-system-prompt-field"
      >
        <FormTextInput
          initialValue={state.systemPrompt}
          onChangeText={model.setSystemPrompt}
          placeholder={t("settings.host.agentProfiles.systemPromptPlaceholder")}
          multiline
          numberOfLines={3}
          style={styles.multilineInput}
          editable={!state.isSubmitting}
          size={controlSize}
          accessibilityLabel={t("settings.host.agentProfiles.systemPromptLabel")}
          testID="agent-profile-system-prompt-input"
        />
      </Field>

      <Field
        label={t("settings.host.agentProfiles.notesLabel")}
        hint={t("settings.host.agentProfiles.notesHint")}
        testID="agent-profile-notes-field"
      >
        <FormTextInput
          initialValue={state.notes}
          onChangeText={model.setNotes}
          placeholder={t("settings.host.agentProfiles.notesPlaceholder")}
          multiline
          numberOfLines={3}
          style={styles.multilineInput}
          editable={!state.isSubmitting}
          size={controlSize}
          accessibilityLabel={t("settings.host.agentProfiles.notesLabel")}
          testID="agent-profile-notes-input"
        />
      </Field>

      {state.disclosure.showControlsField ? (
        <Field
          label={providerOptionsTitle}
          trailing={optionsPendingSpinner}
          testID="agent-profile-features-field"
        >
          <View style={state.controlsPending ? styles.featureCardPending : undefined}>
            <SettingsCard testID="agent-profile-features-card">
              {state.controls.map((control) => (
                <AgentProfileControlRow
                  key={control.key}
                  control={control}
                  options={state.controlOptions}
                  disabled={state.isSubmitting || state.controlsPending}
                  model={model}
                />
              ))}
            </SettingsCard>
          </View>
        </Field>
      ) : null}
    </>
  );
}

/**
 * Shared profile form body used by both the desktop inspector drawer and the modal sheet.
 *
 * Layout order keeps inputs above async provider options: Model first (using Paseo's
 * shared CombinedModelSelector), Name + icon second, Mode & Thinking, "When to use",
 * and provider options last so loading options never shift controls above them.
 */
export function AgentProfileFormFields({
  serverId,
  model,
  state,
  controlSize = "md",
  showInlineIcon = true,
  collapsibleDefaults = false,
}: AgentProfileFormFieldsProps): ReactElement {
  const { t } = useTranslation();
  const nameInputRef = useRef<EditingTextInputHandle>(null);
  const { entries, isLoading, isFetching, isRefreshing, refresh } = useProvidersSnapshot(serverId, {
    cwd: null,
  });

  const modelSelectorProviders = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(entries, {
        selectedProvider: state.provider || null,
      }),
    [entries, state.provider],
  );

  const modelTriggerLeading = useMemo(
    () =>
      state.provider ? (
        <AgentProfileGlyph provider={state.provider} serverId={serverId} size={ICON_SIZE.sm} />
      ) : null,
    [serverId, state.provider],
  );

  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => {
      const displayLabel =
        state.modelDisplay?.label ?? state.providerDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.provider}
          placeholder={t("settings.host.agentProfiles.chooseModelPlaceholder")}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="agent-profile-model-trigger"
        />
      );
    },
    [
      controlSize,
      modelTriggerLeading,
      state.modelDisplay?.label,
      state.provider,
      state.providerDisplay?.label,
      t,
    ],
  );

  const handleAppearanceChange = useCallback(
    (value: { icon: string; color: string }) => model.setAppearance(value),
    [model],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, modelId: string) => {
      const previousName = model.getState().name;
      const entry = entries?.find((candidate) => candidate.provider === provider);
      const modelDef = entry?.models?.find((candidate) => candidate.id === modelId);
      model.setProviderModel(provider, modelId, {
        provider: { label: entry?.label ?? provider },
        model: modelId ? { label: modelDef?.label ?? modelId } : null,
      });
      const suggestedName = model.getState().name;
      if (suggestedName !== previousName) {
        nameInputRef.current?.replaceText(suggestedName);
      }
    },
    [entries, model],
  );

  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void refresh([provider]);
    },
    [refresh],
  );

  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );

  const handleThinkingSelectChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const handleThinkingSegmentChange = useCallback(
    (value: string) => {
      const option = state.thinkingOptions.find((candidate) => candidate.value === value);
      model.setThinking(value, option ? { label: option.label } : null);
    },
    [model, state.thinkingOptions],
  );

  const hasRuntimeDefaults =
    state.disclosure.showModeField ||
    state.disclosure.showThinkingField ||
    state.disclosure.showControlsField;

  const defaultsSummary = useMemo(() => {
    const parts: string[] = [];
    if (state.modeDisplay?.label) {
      parts.push(state.modeDisplay.label);
    }
    if (state.thinkingDisplay?.label) {
      parts.push(state.thinkingDisplay.label);
    }
    if (state.controls.length > 0) {
      parts.push(
        state.controls.length === 1
          ? t("settings.host.agentProfiles.featureCountOne", { count: state.controls.length })
          : t("settings.host.agentProfiles.featureCount", { count: state.controls.length }),
      );
    }
    if (state.systemPrompt.trim()) {
      parts.push(t("settings.host.agentProfiles.systemPromptLabel"));
    }
    if (!state.notes.trim() && !state.systemPrompt.trim() && hasRuntimeDefaults) {
      parts.push(t("settings.host.agentProfiles.addRoutingNoteShort"));
    }
    return parts.join(" · ");
  }, [
    hasRuntimeDefaults,
    state.controls.length,
    state.modeDisplay?.label,
    state.notes,
    state.systemPrompt,
    state.thinkingDisplay?.label,
    t,
  ]);

  const collapsibleLabel = t("settings.host.agentProfiles.customizeSettings");

  const advancedFields = (
    <AgentProfileAdvancedFields
      model={model}
      state={state}
      controlSize={controlSize}
      onModeChange={handleModeChange}
      onThinkingSelectChange={handleThinkingSelectChange}
      onThinkingSegmentChange={handleThinkingSegmentChange}
    />
  );

  return (
    <View style={styles.body}>
      <Field label={t("settings.host.agentProfiles.modelLabel")} testID="agent-profile-model-field">
        <CombinedModelSelector
          providers={modelSelectorProviders}
          selectedProvider={state.provider}
          selectedModel={state.modelId}
          onSelect={handleModelSelect}
          isLoading={isLoading || isFetching}
          renderTrigger={renderModelTrigger}
          triggerFill
          serverId={serverId}
          disabled={state.isSubmitting}
          onRetryProvider={handleRetryProvider}
          isRetryingProvider={isRefreshing}
        />
      </Field>

      <Field label={t("settings.host.agentProfiles.nameLabel")} testID="agent-profile-name-field">
        <View style={styles.nameRow}>
          {showInlineIcon ? (
            <AgentProfileIconButton
              label={t("settings.host.agentProfiles.iconLabel")}
              icon={state.icon}
              color={state.color}
              provider={state.provider || undefined}
              serverId={serverId}
              onChange={handleAppearanceChange}
              disabled={state.isSubmitting}
              size={controlSize}
              triggerTestID="agent-profile-icon-trigger"
            />
          ) : null}
          <View style={styles.nameInputWrap}>
            <FormTextInput
              ref={nameInputRef}
              initialValue={state.name}
              onChangeText={model.setName}
              placeholder={t("settings.host.agentProfiles.namePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!state.isSubmitting}
              size={controlSize}
              accessibilityLabel={t("settings.host.agentProfiles.nameLabel")}
              testID="agent-profile-name-input"
            />
          </View>
        </View>
      </Field>

      {collapsibleDefaults ? (
        <SettingsCard>
          <SettingsCollapsibleRow
            label={collapsibleLabel}
            summary={defaultsSummary || undefined}
            testID="agent-profile-customize"
          >
            <View style={styles.collapsibleFields}>{advancedFields}</View>
          </SettingsCollapsibleRow>
        </SettingsCard>
      ) : (
        advancedFields
      )}

      {state.submitError ? (
        <Text style={styles.submitError} testID="agent-profile-submit-error">
          {state.submitError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  nameInputWrap: {
    flex: 1,
    minWidth: 0,
  },
  collapsibleFields: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  featureCardPending: {
    opacity: theme.opacity[50],
  },
  multilineInput: {
    minHeight: theme.spacing[20],
    textAlignVertical: "top",
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
