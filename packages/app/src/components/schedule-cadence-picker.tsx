import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FormField, FormTextInput } from "@/components/ui/form-field";
import {
  WEEKDAY_LABELS,
  defaultCronDraft,
  defaultIntervalDraft,
  type CadenceDraft,
  type CadenceMode,
  type CronPreset,
  type IntervalUnit,
} from "@/components/schedule-cadence";

interface ScheduleCadencePickerProps {
  value: CadenceDraft;
  timezone: string;
  onChange: (draft: CadenceDraft) => void;
  disabled?: boolean;
}

export function ScheduleCadencePicker({
  value,
  timezone,
  onChange,
  disabled = false,
}: ScheduleCadencePickerProps) {
  const { t } = useTranslation();

  const modeOptions = useMemo(
    () => [
      { value: "interval" as const, label: t("settings.host.schedules.cadence.modeInterval") },
      { value: "cron" as const, label: t("settings.host.schedules.cadence.modeCron") },
    ],
    [t],
  );

  const unitOptions = useMemo(
    () => [
      { value: "minutes" as const, label: t("settings.host.schedules.cadence.unitMinutes") },
      { value: "hours" as const, label: t("settings.host.schedules.cadence.unitHours") },
    ],
    [t],
  );

  const presetOptions = useMemo(
    () => [
      { value: "daily" as const, label: t("settings.host.schedules.cadence.presetDaily") },
      { value: "weekdays" as const, label: t("settings.host.schedules.cadence.presetWeekdays") },
      { value: "weekly" as const, label: t("settings.host.schedules.cadence.presetWeekly") },
      { value: "custom" as const, label: t("settings.host.schedules.cadence.presetCustom") },
    ],
    [t],
  );

  const handleModeChange = useCallback(
    (mode: CadenceMode) => {
      if (mode === value.mode) {
        return;
      }
      onChange(mode === "interval" ? defaultIntervalDraft() : defaultCronDraft(timezone));
    },
    [onChange, timezone, value.mode],
  );

  const handleUnitChange = useCallback(
    (unit: IntervalUnit) => {
      if (value.mode !== "interval") {
        return;
      }
      onChange({ ...value, unit });
    },
    [onChange, value],
  );

  const handleEveryChange = useCallback(
    (every: string) => {
      if (value.mode !== "interval") {
        return;
      }
      onChange({ ...value, every });
    },
    [onChange, value],
  );

  const handlePresetChange = useCallback(
    (preset: CronPreset) => {
      if (value.mode !== "cron") {
        return;
      }
      onChange({ ...value, preset });
    },
    [onChange, value],
  );

  const handleTimeChange = useCallback(
    (time: string) => {
      if (value.mode !== "cron") {
        return;
      }
      onChange({ ...value, time });
    },
    [onChange, value],
  );

  const handleExpressionChange = useCallback(
    (expression: string) => {
      if (value.mode !== "cron") {
        return;
      }
      onChange({ ...value, expression });
    },
    [onChange, value],
  );

  const handleTimezoneChange = useCallback(
    (nextTimezone: string) => {
      if (value.mode !== "cron") {
        return;
      }
      onChange({ ...value, timezone: nextTimezone });
    },
    [onChange, value],
  );

  const handleDayChange = useCallback(
    (dayOfWeek: number) => {
      if (value.mode !== "cron") {
        return;
      }
      onChange({ ...value, dayOfWeek });
    },
    [onChange, value],
  );

  return (
    <View style={styles.container}>
      <FormField label={t("settings.host.schedules.cadence.modeLabel")}>
        <SegmentedControl
          options={modeOptions}
          value={value.mode}
          onValueChange={handleModeChange}
        />
      </FormField>

      {value.mode === "interval" ? (
        <View style={styles.row}>
          <View style={styles.everyField}>
            <FormField label={t("settings.host.schedules.cadence.intervalEvery")}>
              <FormTextInput
                initialValue={value.every}
                resetKey="interval"
                onChangeText={handleEveryChange}
                keyboardType="number-pad"
                editable={!disabled}
                accessibilityLabel={t("settings.host.schedules.cadence.intervalEvery")}
                testID="schedule-cadence-every-input"
              />
            </FormField>
          </View>
          <View style={styles.unitField}>
            <FormField label={t("settings.host.schedules.cadence.unitLabel")}>
              <SegmentedControl
                options={unitOptions}
                value={value.unit}
                onValueChange={handleUnitChange}
              />
            </FormField>
          </View>
        </View>
      ) : (
        <>
          <FormField label={t("settings.host.schedules.cadence.presetLabel")}>
            <SegmentedControl
              options={presetOptions}
              value={value.preset}
              onValueChange={handlePresetChange}
            />
          </FormField>

          {value.preset === "custom" ? (
            <FormField
              label={t("settings.host.schedules.cadence.cronLabel")}
              hint={t("settings.host.schedules.cadence.cronHint")}
            >
              <FormTextInput
                initialValue={value.expression}
                resetKey="custom"
                onChangeText={handleExpressionChange}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                placeholder={t("settings.host.schedules.cadence.cronPlaceholder")}
                accessibilityLabel={t("settings.host.schedules.cadence.cronLabel")}
                testID="schedule-cadence-cron-input"
              />
            </FormField>
          ) : (
            <FormField label={t("settings.host.schedules.cadence.timeLabel")}>
              <FormTextInput
                initialValue={value.time}
                resetKey={`time-${value.preset}`}
                onChangeText={handleTimeChange}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                placeholder="09:00"
                accessibilityLabel={t("settings.host.schedules.cadence.timeLabel")}
                testID="schedule-cadence-time-input"
              />
            </FormField>
          )}

          {value.preset === "weekly" ? (
            <FormField label={t("settings.host.schedules.cadence.dayLabel")}>
              <View style={styles.dayRow}>
                {WEEKDAY_LABELS.map((label, index) => (
                  <DayButton
                    key={label}
                    label={label}
                    day={index}
                    selected={value.dayOfWeek === index}
                    disabled={disabled}
                    onSelect={handleDayChange}
                  />
                ))}
              </View>
            </FormField>
          ) : null}

          {value.preset !== "custom" || value.expression.trim().length > 0 ? (
            <FormField
              label={t("settings.host.schedules.cadence.timezoneLabel")}
              hint={t("settings.host.schedules.cadence.timezoneHint")}
            >
              <FormTextInput
                initialValue={value.timezone}
                resetKey="timezone"
                onChangeText={handleTimezoneChange}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!disabled}
                placeholder="UTC"
                accessibilityLabel={t("settings.host.schedules.cadence.timezoneLabel")}
                testID="schedule-cadence-timezone-input"
              />
            </FormField>
          ) : null}
        </>
      )}
    </View>
  );
}

function DayButton({
  label,
  day,
  selected,
  disabled,
  onSelect,
}: {
  label: string;
  day: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (day: number) => void;
}) {
  const handlePress = useCallback(() => onSelect(day), [day, onSelect]);
  const dayButtonStyle = useMemo(
    () => [styles.dayButton, selected && styles.dayButtonSelected],
    [selected],
  );
  const dayLabelStyle = useMemo(
    () => [styles.dayButtonLabel, selected && styles.dayButtonLabelSelected],
    [selected],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      style={dayButtonStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
      testID={`schedule-cadence-day-${day}`}
    >
      <Text style={dayLabelStyle}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  everyField: {
    flex: 1,
  },
  unitField: {
    flex: 1,
  },
  dayRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  dayButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  dayButtonSelected: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  dayButtonLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  dayButtonLabelSelected: {
    color: theme.colors.background,
    fontWeight: theme.fontWeight.medium,
  },
}));
