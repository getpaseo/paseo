import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentEnvironmentFormat } from "@getpaseo/protocol/agent-environment";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

export interface AgentEnvironmentCommandDraft {
  command: string;
  format: AgentEnvironmentFormat;
  timeoutMs: string;
}

export const EMPTY_AGENT_ENVIRONMENT_DRAFT: AgentEnvironmentCommandDraft = {
  command: "",
  format: "json",
  timeoutMs: "",
};

interface FieldErrors {
  command?: string;
  timeoutMs?: string;
}

interface AgentEnvironmentEditModalProps {
  visible: boolean;
  title: string;
  initialDraft: AgentEnvironmentCommandDraft;
  onClose: () => void;
  onSave: (draft: AgentEnvironmentCommandDraft) => Promise<void>;
  testID?: string;
}

export function AgentEnvironmentEditModal({
  visible,
  title,
  initialDraft,
  onClose,
  onSave,
  testID,
}: AgentEnvironmentEditModalProps) {
  const { t } = useTranslation();
  const [command, setCommand] = useState(initialDraft.command);
  const [format, setFormat] = useState<AgentEnvironmentFormat>(initialDraft.format);
  const [timeoutMs, setTimeoutMs] = useState(initialDraft.timeoutMs);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const commandInputRef = useRef<EditingTextInputHandle>(null);
  const timeoutInputRef = useRef<EditingTextInputHandle>(null);

  const handleCommandChange = useCallback((value: string) => {
    setCommand(value);
    setFieldErrors((current) => ({ ...current, command: undefined }));
  }, []);

  const handleTimeoutChange = useCallback((value: string) => {
    setTimeoutMs(value);
    setFieldErrors((current) => ({ ...current, timeoutMs: undefined }));
  }, []);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title }), [title]);

  const formatOptions = useMemo<SegmentedControlOption<AgentEnvironmentFormat>[]>(
    () => [
      { value: "json", label: t("settings.host.agentEnvironment.formatJson") },
      { value: "env0", label: t("settings.host.agentEnvironment.formatEnv0") },
    ],
    [t],
  );

  useEffect(() => {
    if (!visible) {
      setIsPending(false);
      return;
    }
    setCommand(initialDraft.command);
    setFormat(initialDraft.format);
    setTimeoutMs(initialDraft.timeoutMs);
    setFieldErrors({});
    setSubmitError(null);
    setIsPending(false);

    const timeout = setTimeout(() => {
      commandInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timeout);
  }, [visible, initialDraft.command, initialDraft.format, initialDraft.timeoutMs]);

  const validate = useCallback((): boolean => {
    const errors: FieldErrors = {};
    if (command.trim().length === 0) {
      errors.command = t("settings.host.agentEnvironment.commandRequired");
    }
    const trimmedTimeout = timeoutMs.trim();
    if (trimmedTimeout.length > 0) {
      const parsed = Number(trimmedTimeout);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        errors.timeoutMs = t("settings.host.agentEnvironment.timeoutInvalid");
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [command, t, timeoutMs]);

  const handleSave = useCallback(async () => {
    if (isPending) return;
    setSubmitError(null);

    if (!validate()) {
      return;
    }

    setIsPending(true);
    try {
      await onSave({ command: command.trim(), format, timeoutMs: timeoutMs.trim() });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    } finally {
      setIsPending(false);
    }
  }, [command, format, isPending, onClose, onSave, t, timeoutMs, validate]);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const handleCommandSubmit = useCallback(() => {
    timeoutInputRef.current?.focus();
  }, []);

  const handleTimeoutSubmit = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      onClose={handleCancel}
      testID={testID}
      desktopMaxWidth={480}
    >
      <View style={styles.body}>
        <Field
          label={t("settings.host.agentEnvironment.commandLabel")}
          hint={t("settings.host.agentEnvironment.commandHint")}
          error={fieldErrors.command}
          testID="agent-environment-command-field"
        >
          <FormTextInput
            ref={commandInputRef}
            initialValue={initialDraft.command}
            resetKey={visible ? "open" : "closed"}
            onChangeText={handleCommandChange}
            placeholder={t("settings.host.agentEnvironment.commandPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isPending}
            returnKeyType="next"
            onSubmitEditing={handleCommandSubmit}
            nativeID="agent-environment-command-input"
            accessibilityLabel={t("settings.host.agentEnvironment.commandLabel")}
            testID="agent-environment-command-input"
          />
        </Field>

        <Field
          label={t("settings.host.agentEnvironment.formatLabel")}
          hint={
            format === "json"
              ? t("settings.host.agentEnvironment.formatJsonHint")
              : t("settings.host.agentEnvironment.formatEnv0Hint")
          }
          testID="agent-environment-format-field"
        >
          <SegmentedControl
            options={formatOptions}
            value={format}
            onValueChange={setFormat}
            testID="agent-environment-format-control"
          />
        </Field>

        <Field
          label={t("settings.host.agentEnvironment.timeoutLabel")}
          hint={t("settings.host.agentEnvironment.timeoutHint")}
          error={fieldErrors.timeoutMs}
          testID="agent-environment-timeout-field"
        >
          <FormTextInput
            ref={timeoutInputRef}
            initialValue={initialDraft.timeoutMs}
            resetKey={visible ? "open" : "closed"}
            onChangeText={handleTimeoutChange}
            placeholder={t("settings.host.agentEnvironment.timeoutPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            editable={!isPending}
            returnKeyType="done"
            onSubmitEditing={handleTimeoutSubmit}
            nativeID="agent-environment-timeout-input"
            accessibilityLabel={t("settings.host.agentEnvironment.timeoutLabel")}
            testID="agent-environment-timeout-input"
          />
        </Field>

        {submitError ? (
          <Text style={styles.submitError} testID="agent-environment-submit-error">
            {submitError}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={isPending}
            testID="agent-environment-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSave}
            disabled={isPending}
            testID="agent-environment-save-button"
          >
            {isPending
              ? t("settings.host.agentEnvironment.saving")
              : t("settings.host.agentEnvironment.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
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
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
