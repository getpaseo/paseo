import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FormField, FormTextInput } from "@/components/ui/form-field";
import { SettingsTextArea } from "@/components/settings-textarea";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { ScheduleCadencePicker } from "@/components/schedule-cadence-picker";
import {
  cadenceDraftToCadence,
  cadenceToDraft,
  defaultIntervalDraft,
  getDeviceTimezone,
  type CadenceDraft,
} from "@/components/schedule-cadence";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useScheduleMutations } from "@/hooks/use-schedules";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";

interface ScheduleEditModalProps {
  visible: boolean;
  serverId: string;
  schedule: ScheduleSummary | null;
  onClose: () => void;
}

interface FieldErrors {
  prompt?: string;
  cwd?: string;
  provider?: string;
  cadence?: string;
  maxRuns?: string;
}

export function ScheduleEditModal({
  visible,
  serverId,
  schedule,
  onClose,
}: ScheduleEditModalProps) {
  const { t } = useTranslation();
  const deviceTimezone = useMemo(() => getDeviceTimezone(), []);
  const mutations = useScheduleMutations(serverId);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [provider, setProvider] = useState<AgentProvider | "">("");
  const [model, setModel] = useState("");
  const [cadenceDraft, setCadenceDraft] = useState<CadenceDraft>(() => defaultIntervalDraft());
  const [maxRuns, setMaxRuns] = useState("");
  const [runOnCreate, setRunOnCreate] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const isEdit = schedule !== null;
  const resetKey = `${visible ? "open" : "closed"}:${schedule?.id ?? "new"}`;

  const { entries, isLoading: isModelLoading } = useProvidersSnapshot(serverId, {
    enabled: visible,
    cwd: cwd.trim() || null,
  });
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(entries),
    [entries],
  );

  useEffect(() => {
    if (!visible) {
      setIsPending(false);
      return;
    }
    if (schedule && schedule.target.type === "new-agent") {
      setName(schedule.name ?? "");
      setPrompt(schedule.prompt);
      setCwd(schedule.target.config.cwd);
      setProvider(schedule.target.config.provider);
      setModel(schedule.target.config.model ?? "");
      setCadenceDraft(cadenceToDraft(schedule.cadence, deviceTimezone));
      setMaxRuns(schedule.maxRuns != null ? String(schedule.maxRuns) : "");
      setRunOnCreate(false);
    } else {
      setName("");
      setPrompt("");
      setCwd("");
      setProvider("");
      setModel("");
      setCadenceDraft(defaultIntervalDraft());
      setMaxRuns("");
      setRunOnCreate(true);
    }
    setFieldErrors({});
    setSubmitError(null);
    setIsPending(false);
  }, [visible, schedule, deviceTimezone]);

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: isEdit
        ? t("settings.host.schedules.editTitle")
        : t("settings.host.schedules.createTitle"),
    }),
    [isEdit, t],
  );

  const handleSelectModel = useCallback((nextProvider: AgentProvider, nextModel: string) => {
    setProvider(nextProvider);
    setModel(nextModel);
    setFieldErrors((current) => ({ ...current, provider: undefined }));
  }, []);

  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value);
    setFieldErrors((current) => ({ ...current, prompt: undefined }));
  }, []);

  const handleCwdChange = useCallback((value: string) => {
    setCwd(value);
    setFieldErrors((current) => ({ ...current, cwd: undefined }));
  }, []);

  const handleCadenceChange = useCallback((draft: CadenceDraft) => {
    setCadenceDraft(draft);
    setFieldErrors((current) => ({ ...current, cadence: undefined }));
  }, []);

  const handleMaxRunsChange = useCallback((value: string) => {
    setMaxRuns(value);
    setFieldErrors((current) => ({ ...current, maxRuns: undefined }));
  }, []);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const handleSave = useCallback(async () => {
    if (isPending) return;
    setSubmitError(null);

    const errors: FieldErrors = {};
    const trimmedPrompt = prompt.trim();
    const trimmedCwd = cwd.trim();
    if (!trimmedPrompt) {
      errors.prompt = t("settings.host.schedules.errors.promptRequired");
    }
    if (!trimmedCwd) {
      errors.cwd = t("settings.host.schedules.errors.cwdRequired");
    }
    if (!provider) {
      errors.provider = t("settings.host.schedules.errors.providerRequired");
    }

    const cadenceResult = cadenceDraftToCadence(cadenceDraft);
    if (!cadenceResult.ok) {
      errors.cadence = t("settings.host.schedules.errors.cadenceInvalid");
    }

    let parsedMaxRuns: number | null = null;
    const trimmedMaxRuns = maxRuns.trim();
    if (trimmedMaxRuns) {
      const value = Number.parseInt(trimmedMaxRuns, 10);
      if (!Number.isInteger(value) || value <= 0) {
        errors.maxRuns = t("settings.host.schedules.errors.maxRunsInvalid");
      } else {
        parsedMaxRuns = value;
      }
    }

    if (Object.keys(errors).length > 0 || !cadenceResult.ok || !provider) {
      setFieldErrors(errors);
      return;
    }

    setIsPending(true);
    try {
      if (schedule) {
        await mutations.update({
          id: schedule.id,
          name: name.trim() || null,
          prompt: trimmedPrompt,
          cadence: cadenceResult.cadence,
          newAgentConfig: {
            provider,
            model: model || null,
            cwd: trimmedCwd,
          },
          maxRuns: parsedMaxRuns,
        });
      } else {
        await mutations.create({
          name: name.trim() || null,
          prompt: trimmedPrompt,
          cadence: cadenceResult.cadence,
          target: {
            type: "new-agent",
            config: {
              provider,
              cwd: trimmedCwd,
              ...(model ? { model } : {}),
            },
          },
          ...(parsedMaxRuns != null ? { maxRuns: parsedMaxRuns } : {}),
          runOnCreate,
        });
      }
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    } finally {
      setIsPending(false);
    }
  }, [
    cadenceDraft,
    cwd,
    isPending,
    maxRuns,
    model,
    mutations,
    name,
    onClose,
    prompt,
    provider,
    runOnCreate,
    schedule,
    t,
  ]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      onClose={handleCancel}
      testID="schedule-edit-modal"
      desktopMaxWidth={560}
    >
      <View style={styles.body}>
        <FormField label={t("settings.host.schedules.nameLabel")}>
          <FormTextInput
            initialValue={name}
            resetKey={resetKey}
            onChangeText={setName}
            placeholder={t("settings.host.schedules.namePlaceholder")}
            editable={!isPending}
            accessibilityLabel={t("settings.host.schedules.nameLabel")}
            testID="schedule-name-input"
          />
        </FormField>

        <FormField
          label={t("settings.host.schedules.promptLabel")}
          error={fieldErrors.prompt}
          hint={t("settings.host.schedules.promptHint")}
        >
          <View style={styles.textAreaWrapper}>
            <SettingsTextArea
              accessibilityLabel={t("settings.host.schedules.promptLabel")}
              value={prompt}
              onChangeText={handlePromptChange}
              placeholder={t("settings.host.schedules.promptPlaceholder")}
              testID="schedule-prompt-input"
            />
          </View>
        </FormField>

        <FormField label={t("settings.host.schedules.providerLabel")} error={fieldErrors.provider}>
          <View style={styles.selectorWrapper}>
            <CombinedModelSelector
              providers={modelSelectorProviders}
              selectedProvider={provider}
              selectedModel={model}
              onSelect={handleSelectModel}
              isLoading={isModelLoading}
              serverId={serverId}
            />
          </View>
        </FormField>

        <FormField
          label={t("settings.host.schedules.cwdLabel")}
          error={fieldErrors.cwd}
          hint={t("settings.host.schedules.cwdHint")}
        >
          <FormTextInput
            initialValue={cwd}
            resetKey={resetKey}
            onChangeText={handleCwdChange}
            placeholder={t("settings.host.schedules.cwdPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isPending}
            accessibilityLabel={t("settings.host.schedules.cwdLabel")}
            testID="schedule-cwd-input"
          />
        </FormField>

        <ScheduleCadencePicker
          value={cadenceDraft}
          timezone={deviceTimezone}
          onChange={handleCadenceChange}
          disabled={isPending}
        />
        {fieldErrors.cadence ? <Text style={styles.fieldError}>{fieldErrors.cadence}</Text> : null}

        <FormField
          label={t("settings.host.schedules.maxRunsLabel")}
          error={fieldErrors.maxRuns}
          hint={t("settings.host.schedules.maxRunsHint")}
        >
          <FormTextInput
            initialValue={maxRuns}
            resetKey={resetKey}
            onChangeText={handleMaxRunsChange}
            placeholder={t("settings.host.schedules.maxRunsPlaceholder")}
            keyboardType="number-pad"
            editable={!isPending}
            accessibilityLabel={t("settings.host.schedules.maxRunsLabel")}
            testID="schedule-max-runs-input"
          />
        </FormField>

        {!isEdit ? (
          <View style={styles.switchRow}>
            <View style={styles.switchLabel}>
              <Text style={styles.switchTitle}>
                {t("settings.host.schedules.runOnCreateLabel")}
              </Text>
              <Text style={styles.switchHint}>{t("settings.host.schedules.runOnCreateHint")}</Text>
            </View>
            <Switch
              value={runOnCreate}
              onValueChange={setRunOnCreate}
              disabled={isPending}
              accessibilityLabel={t("settings.host.schedules.runOnCreateLabel")}
            />
          </View>
        ) : null}

        {submitError ? (
          <Text style={styles.submitError} testID="schedule-submit-error">
            {submitError}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={isPending}
            testID="schedule-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={isPending}
            testID="schedule-save-button"
          >
            {isPending ? t("settings.host.schedules.saving") : t("settings.host.schedules.save")}
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
  textAreaWrapper: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  selectorWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  switchLabel: {
    flex: 1,
    gap: theme.spacing[1],
  },
  switchTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  switchHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  fieldError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    marginTop: -theme.spacing[2],
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
