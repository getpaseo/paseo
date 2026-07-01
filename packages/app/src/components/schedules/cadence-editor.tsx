import { type ReactNode, useCallback, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { isWeb } from "@/constants/platform";
import {
  describeCron,
  everyMsToParts,
  type IntervalUnit,
  partsToEveryMs,
  validateCron,
} from "@/utils/schedule-format";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

type CadenceMode = ScheduleCadence["type"];

interface CronPreset {
  label: string;
  expression: string;
}

// 5-field expressions evaluated in UTC by the daemon. Each one round-trips
// through describeCron() so the chip and the live preview agree.
const CRON_PRESETS: CronPreset[] = [
  { label: "Every hour", expression: "0 * * * *" },
  { label: "Daily 9:00", expression: "0 9 * * *" },
  { label: "Weekdays 9:00", expression: "0 9 * * 1-5" },
  { label: "Mondays 9:00", expression: "0 9 * * 1" },
];

const MODE_OPTIONS = [
  { value: "every" as const, label: "Interval" },
  { value: "cron" as const, label: "Cron" },
];

const UNIT_OPTIONS = [
  { value: "minutes" as const, label: "Minutes" },
  { value: "hours" as const, label: "Hours" },
  { value: "days" as const, label: "Days" },
];

const DEFAULT_INTERVAL_MS = partsToEveryMs(1, "hours");
const DEFAULT_CRON_EXPRESSION = "0 9 * * *";

const UNIT_NOUN: Record<IntervalUnit, string> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

function describeInterval(value: number, unit: IntervalUnit): string {
  const noun = UNIT_NOUN[unit];
  if (value === 1) {
    return `Runs every ${noun}`;
  }
  return `Runs every ${value} ${noun}s`;
}

export interface CadenceEditorProps {
  value: ScheduleCadence;
  onChange: (next: ScheduleCadence) => void;
  error?: string;
}

export function CadenceEditor({ value, onChange, error }: CadenceEditorProps) {
  const mode = value.type;

  // The numeric/text fields are native-owned (AdaptiveTextInput). We seed them
  // once from the incoming cadence via lazy state initializers and bump
  // resetKey only when we change the content ourselves (mode switch, preset
  // chip) — never on every keystroke.
  const [intervalValueText, setIntervalValueText] = useState(() =>
    String(everyMsToParts(value.type === "every" ? value.everyMs : DEFAULT_INTERVAL_MS).value),
  );
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(
    () => everyMsToParts(value.type === "every" ? value.everyMs : DEFAULT_INTERVAL_MS).unit,
  );
  const [cronText, setCronText] = useState(() =>
    value.type === "cron" ? value.expression : DEFAULT_CRON_EXPRESSION,
  );
  const [fieldResetKey, bumpFieldResetKey] = useReducer((key: number) => key + 1, 0);

  // Remember the cron expression the user had so toggling Interval -> Cron and
  // back does not discard a blanked-out field. Interval mode rebuilds straight
  // from the live numeric value + unit, so it needs no equivalent ref.
  const lastCronExpression = useRef(
    value.type === "cron" ? value.expression : DEFAULT_CRON_EXPRESSION,
  );

  const parsedIntervalValue = useMemo(() => {
    const parsed = Number.parseInt(intervalValueText, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }, [intervalValueText]);

  const emitInterval = useCallback(
    (rawValue: number, unit: IntervalUnit) => {
      onChange({ type: "every", everyMs: partsToEveryMs(rawValue, unit) });
    },
    [onChange],
  );

  const emitCron = useCallback(
    (expression: string) => {
      lastCronExpression.current = expression;
      onChange({ type: "cron", expression });
    },
    [onChange],
  );

  const handleModeChange = useCallback(
    (nextMode: CadenceMode) => {
      if (nextMode === mode) {
        return;
      }
      if (nextMode === "every") {
        emitInterval(parsedIntervalValue, intervalUnit);
      } else {
        emitCron(cronText.trim() || lastCronExpression.current);
      }
    },
    [mode, parsedIntervalValue, intervalUnit, cronText, emitInterval, emitCron],
  );

  const handleIntervalValueChange = useCallback(
    (text: string) => {
      // Keep only digits so the cadence stays a positive integer count.
      const digits = text.replace(/[^0-9]/g, "");
      setIntervalValueText(digits);
      const parsed = Number.parseInt(digits, 10);
      emitInterval(Number.isFinite(parsed) && parsed > 0 ? parsed : 1, intervalUnit);
    },
    [emitInterval, intervalUnit],
  );

  const handleUnitChange = useCallback(
    (unit: IntervalUnit) => {
      setIntervalUnit(unit);
      emitInterval(parsedIntervalValue, unit);
    },
    [emitInterval, parsedIntervalValue],
  );

  const handleCronChange = useCallback(
    (text: string) => {
      setCronText(text);
      emitCron(text.trim());
    },
    [emitCron],
  );

  const handlePresetPress = useCallback(
    (expression: string) => {
      setCronText(expression);
      bumpFieldResetKey();
      emitCron(expression);
    },
    [emitCron],
  );

  const intervalPreview = describeInterval(parsedIntervalValue, intervalUnit);
  const trimmedCron = cronText.trim();
  const cronError = trimmedCron ? validateCron(trimmedCron) : null;
  const cronPreview = cronError ? null : (describeCron(trimmedCron) ?? trimmedCron);

  let cronFeedback: ReactNode = null;
  if (cronError) {
    cronFeedback = <Text style={styles.error}>{cronError}</Text>;
  } else if (cronPreview) {
    cronFeedback = <Text style={styles.preview}>{cronPreview}</Text>;
  }

  return (
    <View style={styles.container}>
      <SegmentedControl
        size="sm"
        value={mode}
        onValueChange={handleModeChange}
        options={MODE_OPTIONS}
        style={styles.modeControl}
        testID="cadence-mode"
      />

      {mode === "every" ? (
        <View style={styles.section}>
          <View style={styles.intervalRow}>
            <AdaptiveTextInput
              testID="cadence-interval-value"
              accessibilityLabel="Interval value"
              initialValue={intervalValueText}
              resetKey={`cadence-interval-${fieldResetKey}`}
              value={intervalValueText}
              onChangeText={handleIntervalValueChange}
              keyboardType="number-pad"
              style={styles.intervalInput}
            />
            <SegmentedControl
              size="sm"
              value={intervalUnit}
              onValueChange={handleUnitChange}
              options={UNIT_OPTIONS}
              style={styles.unitControl}
              testID="cadence-interval-unit"
            />
          </View>
          <Text style={styles.preview}>{intervalPreview}</Text>
        </View>
      ) : (
        <View style={styles.section}>
          <View style={styles.presetRow}>
            {CRON_PRESETS.map((preset) => (
              <CronPresetChip
                key={preset.expression}
                label={preset.label}
                expression={preset.expression}
                isSelected={trimmedCron === preset.expression}
                onSelect={handlePresetPress}
              />
            ))}
          </View>
          <AdaptiveTextInput
            testID="cadence-cron-expression"
            accessibilityLabel="Cron expression"
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
          {cronFeedback}
          <Text style={styles.hint}>Times are in UTC</Text>
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function CronPresetChip({
  label,
  expression,
  isSelected,
  onSelect,
}: {
  label: string;
  expression: string;
  isSelected: boolean;
  onSelect: (expression: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(expression);
  }, [onSelect, expression]);
  const chipStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.chip,
      isSelected && styles.chipSelected,
      !isSelected && (Boolean(hovered) || pressed) && styles.chipHover,
    ],
    [isSelected],
  );
  const labelStyle = useMemo(
    () => [styles.chipLabel, isSelected && styles.chipLabelSelected],
    [isSelected],
  );
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={chipStyle}
    >
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const MONOSPACE_FONT = isWeb ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "Menlo";

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  section: {
    gap: theme.spacing[3],
  },
  intervalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  intervalInput: {
    width: 88,
    minHeight: 44,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  // Both cadence segmented controls hug their options and stand at the form's
  // field height, so the interval row reads as input + toggle rather than a
  // full-width track with the controls floating inside it.
  modeControl: {
    alignSelf: "flex-start",
    height: 44,
  },
  unitControl: {
    height: 44,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chip: {
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  chipHover: {
    backgroundColor: theme.colors.surface3,
  },
  chipSelected: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  chipLabelSelected: {
    color: theme.colors.accentForeground,
  },
  cronInput: {
    minHeight: 44,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
    fontFamily: MONOSPACE_FONT,
  },
  preview: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
