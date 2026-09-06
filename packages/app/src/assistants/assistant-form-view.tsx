import { useCallback, useMemo, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  ASSISTANT_CONTEXT_MAX_LENGTH,
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  type AssistantFormError,
  type AssistantFormModel,
} from "./assistant-form-model";

const NONE_OPTION_ID = "__none__";

function resolveFormErrorMessage(t: TFunction, error: AssistantFormError | null): string | null {
  switch (error) {
    case "name_required":
      return t("assistants.form.errors.nameRequired");
    case "name_too_long":
      return t("assistants.form.errors.nameTooLong");
    case "too_long":
      return t("assistants.form.errors.tooLong");
    case null:
      return null;
  }
}

/**
 * The fields of an assistant or template. The model owns every value; this
 * renders state and dispatches intent, and the sheet around it owns submit.
 */
export function AssistantFormView({
  model,
  disabled,
}: {
  model: AssistantFormModel;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const showTemplatePicker = state.kind === "assistant" && state.mode === "create";

  const templateOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: NONE_OPTION_ID,
        value: NONE_OPTION_ID,
        label: t("assistants.form.startFrom.none"),
        testID: "assistant-form-template-none",
      },
      ...state.templates.map((template) => ({
        id: template.id,
        value: template.id,
        label: template.name,
        testID: `assistant-form-template-${template.id}`,
      })),
    ],
    [state.templates, t],
  );
  const selectedTemplate = state.templates.find((template) => template.id === state.templateId);

  const voiceOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const voices = [...state.voiceOptions];
    const current = state.configuration.voice;
    // A voice chosen on another catalog stays visible rather than silently
    // reading as default; the daemon resolves what it cannot find.
    if (current && !voices.includes(current)) {
      voices.push(current);
    }
    return [
      {
        id: NONE_OPTION_ID,
        value: NONE_OPTION_ID,
        label: t("assistants.form.voice.default"),
      },
      ...voices.map((voice) => ({ id: voice, value: voice, label: voice })),
    ];
  }, [state.configuration.voice, state.voiceOptions, t]);

  const backendModelOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const current = state.configuration.backendModel;
    const known = state.backendModelOptions.map((option) => ({
      id: option.id,
      value: option.id,
      label: option.label,
    }));
    if (current && !state.backendModelOptions.some((option) => option.id === current)) {
      known.push({ id: current, value: current, label: current });
    }
    return [
      {
        id: NONE_OPTION_ID,
        value: NONE_OPTION_ID,
        label: t("assistants.form.backendModel.default"),
      },
      ...known,
    ];
  }, [state.backendModelOptions, state.configuration.backendModel, t]);
  const backendModelLabel = state.configuration.backendModel
    ? (state.backendModelOptions.find((option) => option.id === state.configuration.backendModel)
        ?.label ?? state.configuration.backendModel)
    : t("assistants.form.backendModel.default");

  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      {
        id: NONE_OPTION_ID,
        value: NONE_OPTION_ID,
        label: t("assistants.form.backendThinking.default"),
      },
      ...state.availableThinkingOptionIds.map((id) => ({ id, value: id, label: id })),
    ],
    [state.availableThinkingOptionIds, t],
  );

  const templateDisplay = useMemo(
    () => ({ label: selectedTemplate?.name ?? t("assistants.form.startFrom.none") }),
    [selectedTemplate?.name, t],
  );
  const voiceDisplay = useMemo(
    () => ({ label: state.configuration.voice ?? t("assistants.form.voice.default") }),
    [state.configuration.voice, t],
  );
  const modelDisplay = useMemo(() => ({ label: backendModelLabel }), [backendModelLabel]);
  const thinkingDisplay = useMemo(
    () => ({
      label:
        state.configuration.backendThinkingOptionId ?? t("assistants.form.backendThinking.default"),
    }),
    [state.configuration.backendThinkingOptionId, t],
  );
  const handleSelectTemplate = useCallback(
    (value: string) => {
      model.setTemplate(value === NONE_OPTION_ID ? null : value);
    },
    [model],
  );
  const handleSelectVoice = useCallback(
    (value: string) => {
      model.setVoice(value === NONE_OPTION_ID ? null : value);
    },
    [model],
  );
  const handleSelectBackendModel = useCallback(
    (value: string) => {
      model.setBackendModel(value === NONE_OPTION_ID ? null : value);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (value: string) => {
      model.setBackendThinking(value === NONE_OPTION_ID ? null : value);
    },
    [model],
  );

  const nameError = resolveFormErrorMessage(t, state.nameError);
  const contextResetKey = `${state.templateId ?? ""}`;

  return (
    <View style={styles.fields}>
      <Field
        label={t("assistants.form.name.label")}
        error={state.nameError === "too_long" ? null : nameError}
        testID="assistant-form-name-field"
      >
        <FormTextInput
          size={size}
          initialValue={state.name}
          onChangeText={model.setName}
          editable={!disabled}
          placeholder={t("assistants.form.name.placeholder")}
          autoCorrect={false}
          accessibilityLabel={t("assistants.form.name.label")}
          testID="assistant-form-name"
        />
      </Field>

      {showTemplatePicker ? (
        <SelectField
          label={t("assistants.form.startFrom.label")}
          hint={t("assistants.form.startFrom.hint")}
          value={state.templateId ?? NONE_OPTION_ID}
          selectedDisplay={templateDisplay}
          options={templateOptions}
          onChange={handleSelectTemplate}
          placeholder={t("assistants.form.startFrom.none")}
          emptyText={t("assistants.form.startFrom.empty")}
          disabled={disabled}
          size={size}
          testID="assistant-form-template"
        />
      ) : null}

      <Field
        label={t("assistants.form.instructions.label")}
        hint={t("assistants.form.instructions.hint", {
          length: state.configuration.instructions.length,
          max: ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
        })}
        error={
          state.configuration.instructions.length > ASSISTANT_INSTRUCTIONS_MAX_LENGTH
            ? t("assistants.form.errors.tooLong")
            : null
        }
      >
        <FormTextInput
          size={size}
          initialValue={state.configuration.instructions}
          resetKey={contextResetKey}
          onChangeText={model.setInstructions}
          editable={!disabled}
          placeholder={t("assistants.form.instructions.placeholder")}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          accessibilityLabel={t("assistants.form.instructions.label")}
          testID="assistant-form-instructions"
        />
      </Field>

      <Field
        label={t("assistants.form.context.label")}
        hint={t("assistants.form.context.hint", {
          length: state.configuration.context.length,
          max: ASSISTANT_CONTEXT_MAX_LENGTH,
        })}
        error={
          state.configuration.context.length > ASSISTANT_CONTEXT_MAX_LENGTH
            ? t("assistants.form.errors.tooLong")
            : null
        }
      >
        <FormTextInput
          size={size}
          initialValue={state.configuration.context}
          resetKey={contextResetKey}
          onChangeText={model.setContext}
          editable={!disabled}
          placeholder={t("assistants.form.context.placeholder")}
          style={styles.multilineInputTall}
          multiline
          numberOfLines={6}
          textAlignVertical="top"
          accessibilityLabel={t("assistants.form.context.label")}
          testID="assistant-form-context"
        />
      </Field>

      <SelectField
        label={t("assistants.form.voice.label")}
        hint={t("assistants.form.voice.hint")}
        value={state.configuration.voice ?? NONE_OPTION_ID}
        selectedDisplay={voiceDisplay}
        options={voiceOptions}
        onChange={handleSelectVoice}
        placeholder={t("assistants.form.voice.default")}
        emptyText={t("assistants.form.voice.default")}
        disabled={disabled}
        size={size}
        testID="assistant-form-voice"
      />

      <SelectField
        label={t("assistants.form.backendModel.label")}
        hint={t("assistants.form.backendModel.hint")}
        value={state.configuration.backendModel ?? NONE_OPTION_ID}
        selectedDisplay={modelDisplay}
        options={backendModelOptions}
        onChange={handleSelectBackendModel}
        placeholder={t("assistants.form.backendModel.default")}
        emptyText={t("assistants.form.backendModel.default")}
        disabled={disabled}
        size={size}
        testID="assistant-form-backend-model"
      />

      {state.configuration.backendModel ? (
        <SelectField
          label={t("assistants.form.backendThinking.label")}
          hint={t("assistants.form.backendThinking.hint")}
          value={state.configuration.backendThinkingOptionId ?? NONE_OPTION_ID}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={handleSelectThinking}
          placeholder={t("assistants.form.backendThinking.default")}
          emptyText={t("assistants.form.backendThinking.default")}
          disabled={disabled || state.availableThinkingOptionIds.length === 0}
          size={size}
          testID="assistant-form-backend-thinking"
        />
      ) : null}

      {state.submitError ? (
        <Text style={styles.submitError} testID="assistant-form-error">
          {state.submitError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fields: {
    gap: theme.spacing[4],
  },
  multilineInput: {
    minHeight: 96,
  },
  multilineInputTall: {
    minHeight: 144,
  },
  submitError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
