import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import {
  CADENCE_PRESET_OPTIONS,
  cadencePresetLabel,
  normalizeScheduleFormCadence,
  resolveCronPresetDisplay,
  resolveCronPresetId,
} from "@/schedules/schedule-cadence-options";
import { getDeviceTimeZone } from "@/utils/device-timezone";
import { describeCron, validateCron } from "@/utils/schedule-format";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export interface CadenceEditorProps {
  value: ScheduleCadence;
  onChange: (next: ScheduleCadence) => void;
  error?: string;
  size?: FieldControlSize;
}

function getCronPreview(expression: string, timezone: string, error: string | null): string | null {
  if (error || !expression) {
    return null;
  }
  return describeCron({ type: "cron", expression, timezone }) ?? expression;
}

function buildCronCadence(expression: string, timezone: string): CronCadence {
  return { type: "cron", expression, timezone };
}

export function CadenceEditor({ value, onChange, error, size = "md" }: CadenceEditorProps) {
  const { t } = useTranslation();
  const deviceTimeZone = useMemo(getDeviceTimeZone, []);
  const normalizedValue = normalizeScheduleFormCadence(value, deviceTimeZone);
  const [cronText, setCronText] = useState(() => normalizedValue.expression);
  const [fieldResetKey, bumpFieldResetKey] = useReducer((key: number) => key + 1, 0);
  const cronTimeZone = normalizedValue.timezone ?? deviceTimeZone;
  const trimmedCron = cronText.trim();
  const localCronError = trimmedCron ? validateCron(trimmedCron) : null;
  const effectiveError = error ?? localCronError;
  const preview = getCronPreview(trimmedCron, cronTimeZone, effectiveError ?? null);
  const currentCadence = useMemo<CronCadence>(
    () => buildCronCadence(trimmedCron, cronTimeZone),
    [cronTimeZone, trimmedCron],
  );
  const selectedPresetId = resolveCronPresetId(currentCadence);
  const selectedPresetDisplay = resolveCronPresetDisplay(currentCadence);
  // Labels come from i18n; useTranslation() re-renders this component on language change.
  const presetOptions: SelectFieldOption<string>[] = CADENCE_PRESET_OPTIONS.map((option) => ({
    id: option.id,
    value: option.id,
    label: cadencePresetLabel(option.id),
    testID: `schedule-cadence-preset-${option.id}`,
  }));

  const handlePresetChange = useCallback(
    (presetId: string) => {
      const preset = CADENCE_PRESET_OPTIONS.find((option) => option.id === presetId);
      if (!preset) {
        return;
      }
      setCronText(preset.expression);
      bumpFieldResetKey();
      onChange(buildCronCadence(preset.expression, cronTimeZone));
    },
    [cronTimeZone, onChange],
  );

  const handleCronChange = useCallback(
    (text: string) => {
      setCronText(text);
      onChange(buildCronCadence(text.trim(), cronTimeZone));
    },
    [cronTimeZone, onChange],
  );

  let feedback: ReactNode = null;
  if (effectiveError) {
    feedback = <Text style={styles.error}>{effectiveError}</Text>;
  } else if (preview) {
    feedback = <Text style={styles.preview}>{preview}</Text>;
  }

  return (
    <Field label={t("schedules.cadence.fieldLabel")}>
      <View style={styles.stack}>
        <SelectField
          label={t("schedules.cadence.fieldLabel")}
          value={selectedPresetId === "custom" ? null : selectedPresetId}
          selectedDisplay={selectedPresetDisplay}
          options={presetOptions}
          onChange={handlePresetChange}
          placeholder={t("schedules.cadence.placeholder")}
          emptyText={t("schedules.cadence.empty")}
          searchable={false}
          title={t("schedules.cadence.fieldLabel")}
          size={size}
          triggerTestID="schedule-cadence-preset-trigger"
          field={false}
        />

        <FormTextInput
          size={size}
          testID="cadence-cron-expression"
          accessibilityLabel={t("schedules.cadence.cronAccessibility")}
          initialValue={cronText}
          resetKey={`cadence-cron-${fieldResetKey}`}
          value={cronText}
          onChangeText={handleCronChange}
          placeholder="0 9 * * *"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={styles.cronInput}
        />
        {feedback}
      </View>
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[3],
  },
  cronInput: {
    fontFamily: theme.fontFamily.mono,
  },
  preview: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
}));
