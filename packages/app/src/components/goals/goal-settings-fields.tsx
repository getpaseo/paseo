import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { durationLabel } from "@/goals/goal-labels";
import { GOAL_BUDGET_FIELDS, GOAL_SETTING_FIELDS } from "@/goals/goal-number-fields";
import { formatCompactCount, formatUsd } from "@/goals/goal-progress";
import {
  minutesToDuration,
  secondsToDuration,
  type GoalBudgetKey,
  type GoalNumberSetting,
  type GoalPermissionPolicy,
} from "@/goals/goal-settings";
import { SettingRow } from "./goal-form-fields";
import { ScrubNumberField } from "./scrub-number-field";

/**
 * The goal settings controls the create form and the settings sheet share. Each takes a value
 * and reports changes; the caller's model owns the state.
 */

export function GoalSettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  );
}

function describeSetting(
  t: ReturnType<typeof useTranslation>["t"],
  setting: GoalNumberSetting,
  value: number,
): string {
  if (
    setting === "runTimeoutMinutes" ||
    setting === "goalTimeoutMinutes" ||
    setting === "userWaitMinutes"
  ) {
    return durationLabel(t, minutesToDuration(value));
  }
  if (setting === "retryBackoffSeconds") {
    return durationLabel(t, secondsToDuration(value));
  }
  return String(value);
}

export function GoalNumberSettingField({
  setting,
  value,
  onChange,
  error,
  size,
}: {
  setting: GoalNumberSetting;
  value: number;
  onChange: (setting: GoalNumberSetting, value: number) => void;
  error?: string | null;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const field = GOAL_SETTING_FIELDS[setting];
  const label = t(`goals.form.settings.${setting}.label`);
  const handleChange = useCallback(
    (next: number | null) => {
      if (next !== null) {
        onChange(setting, next);
      }
    },
    [onChange, setting],
  );
  const describeValue = useCallback(
    (next: number | null) => (next === null ? "" : describeSetting(t, setting, next)),
    [setting, t],
  );
  return (
    <SettingRow label={label} hint={t(`goals.form.settings.${setting}.hint`)}>
      <ScrubNumberField
        label={label}
        value={value}
        onChange={handleChange}
        scale={field.scale}
        format={field.format}
        inputMode={field.inputMode}
        describeValue={describeValue}
        error={error}
        size={size}
        testID={`goal-setting-${setting}`}
      />
    </SettingRow>
  );
}

const BUDGET_FORMAT: Record<GoalBudgetKey, (value: number) => string> = {
  maxTotalTokens: formatCompactCount,
  maxCostUsd: formatUsd,
};

export function GoalBudgetField({
  budgetKey,
  value,
  onChange,
  error,
  size,
}: {
  budgetKey: GoalBudgetKey;
  /** Null is no cap. */
  value: number | null;
  onChange: (budgetKey: GoalBudgetKey, value: number | null) => void;
  error?: string | null;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const field = GOAL_BUDGET_FIELDS[budgetKey];
  const format = BUDGET_FORMAT[budgetKey];
  const label = t(`goals.form.settings.${budgetKey}.label`);
  const noLimit = t("goals.form.noLimit");
  const handleChange = useCallback(
    (next: number | null) => onChange(budgetKey, next),
    [budgetKey, onChange],
  );
  const describeValue = useCallback(
    (next: number | null) => (next === null ? noLimit : format(next)),
    [format, noLimit],
  );
  return (
    <SettingRow label={label} hint={t(`goals.form.settings.${budgetKey}.hint`)}>
      <ScrubNumberField
        label={label}
        value={value}
        onChange={handleChange}
        scale={field.scale}
        format={field.format}
        inputMode={field.inputMode}
        describeValue={describeValue}
        placeholder={noLimit}
        error={error}
        size={size}
        testID={`goal-budget-${budgetKey}`}
      />
    </SettingRow>
  );
}

/** Who answers an agent's permission request. The hint explains the selected policy. */
export function GoalPermissionPolicyField({
  value,
  options,
  onChange,
  size,
}: {
  value: GoalPermissionPolicy;
  /** In display order; see goalPermissionPolicyOptions. */
  options: readonly GoalPermissionPolicy[];
  onChange: (value: GoalPermissionPolicy) => void;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const segments = useMemo<SegmentedControlOption<GoalPermissionPolicy>[]>(
    () =>
      options.map((policy) => ({
        value: policy,
        label: t(`goals.form.permission.${policy}`),
        testID: `goal-permission-${policy}`,
      })),
    [options, t],
  );
  return (
    <View style={styles.block}>
      <SettingRow
        label={t("goals.form.settings.onPermissionRequest.label")}
        hint={t(`goals.form.permissionHints.${value}`)}
        testID="goal-permission-row"
      />
      <SegmentedControl
        options={segments}
        value={value}
        onValueChange={onChange}
        size={size}
        testID="goal-permission"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: {
    gap: theme.spacing[4],
  },
  groupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  block: {
    gap: theme.spacing[2],
  },
}));
