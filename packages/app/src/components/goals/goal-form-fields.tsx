import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { ComboboxItem } from "@/components/ui/combobox";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import type { GoalProviderOption, GoalThinkingOption } from "@/goals/goal-form-model";

/** A setting row: label and one-line explanation on the left, its control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  testID,
}: {
  label: string;
  hint: string;
  children?: ReactNode;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.settingRow} testID={testID}>
      <View style={styles.settingText}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingHint}>{hint}</Text>
      </View>
      {children ? <View style={styles.settingControl}>{children}</View> : null}
    </View>
  );
}

export function SwitchSetting({
  label,
  hint,
  value,
  onChange,
  testID,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (value: boolean) => void;
  testID: string;
}): ReactElement {
  return (
    <SettingRow label={label} hint={hint}>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} testID={testID} />
    </SettingRow>
  );
}

export function ProviderSelect({
  label,
  value,
  onChange,
  options,
  serverId,
  loading,
  size,
  emptyLabel,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly GoalProviderOption[];
  serverId: string;
  loading: boolean;
  size: FieldControlSize;
  /** When set, an extra first option that clears the selection. */
  emptyLabel?: string;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const selectOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const providerOptions = options.map((option) => ({
      id: option.id,
      value: option.id,
      label: option.label,
      testID: `${testID}-option-${option.id}`,
    }));
    return emptyLabel
      ? [
          { id: "", value: "", label: emptyLabel, testID: `${testID}-option-none` },
          ...providerOptions,
        ]
      : providerOptions;
  }, [emptyLabel, options, testID]);
  // The prefilled id stands in for its label until the providers snapshot arrives.
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!value) {
      return emptyLabel ? { label: emptyLabel } : null;
    }
    return { label: options.find((option) => option.id === value)?.label ?? value };
  }, [emptyLabel, options, value]);
  const handleChange = useCallback((next: string) => onChange(next), [onChange]);
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => (
      <ProviderOptionItem {...input} serverId={serverId} />
    ),
    [serverId],
  );
  const triggerLeading = useMemo(
    () => (value ? <ProviderGlyph provider={value} serverId={serverId} /> : undefined),
    [serverId, value],
  );

  return (
    <SelectField
      label={label}
      value={emptyLabel || value ? value : null}
      selectedDisplay={selectedDisplay}
      options={selectOptions}
      onChange={handleChange}
      placeholder={t("goals.form.providerPlaceholder")}
      emptyText={t("goals.form.providerEmpty")}
      loading={loading}
      searchable={false}
      title={label}
      size={size}
      renderOption={renderOption}
      triggerLeading={triggerLeading}
      testID={testID}
      triggerTestID={`${testID}-trigger`}
    />
  );
}

/**
 * The model for one provider picker. Hidden until a provider is chosen and lists models; the
 * empty option leaves the model to the provider's default.
 */
export function ModelSelect({
  label,
  provider,
  value,
  onChange,
  options,
  size,
  testID,
}: {
  label: string;
  provider: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly GoalProviderOption[];
  size: FieldControlSize;
  testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const models = useMemo(
    () => options.find((option) => option.id === provider)?.models ?? [],
    [options, provider],
  );
  const defaultLabel = t("goals.form.modelDefault");
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: defaultLabel, testID: `${testID}-option-default` },
      ...models.map((entry) => ({
        id: entry.id,
        value: entry.id,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        testID: `${testID}-option-${entry.id}`,
      })),
    ],
    [defaultLabel, models, testID],
  );
  // A prefilled model stands in for its label until the providers snapshot arrives.
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () =>
      value
        ? { label: models.find((entry) => entry.id === value)?.label ?? value }
        : { label: defaultLabel },
    [defaultLabel, models, value],
  );
  const handleChange = useCallback((next: string) => onChange(next), [onChange]);

  if (!provider || (models.length === 0 && !value)) {
    return null;
  }
  return (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={selectedDisplay}
      options={selectOptions}
      onChange={handleChange}
      placeholder={defaultLabel}
      emptyText={t("goals.form.modelEmpty")}
      searchable={models.length > 8}
      title={label}
      size={size}
      testID={testID}
      triggerTestID={`${testID}-trigger`}
    />
  );
}

/**
 * The thinking level for one role, from the levels its model offers. Hidden when the model
 * offers none; the empty option leaves the model's default and sends nothing.
 */
export function ThinkingSelect({
  label,
  value,
  onChange,
  options,
  size,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly GoalThinkingOption[];
  size: FieldControlSize;
  testID: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const defaultLabel = t("goals.form.thinkingDefault");
  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () => [
      { id: "", value: "", label: defaultLabel, testID: `${testID}-option-default` },
      ...options.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        ...(option.description ? { description: option.description } : {}),
        testID: `${testID}-option-${option.id}`,
      })),
    ],
    [defaultLabel, options, testID],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(() => {
    const option = options.find((entry) => entry.id === value);
    return { label: option ? formatThinkingOptionLabel(option) : defaultLabel };
  }, [defaultLabel, options, value]);
  const handleChange = useCallback((next: string) => onChange(next), [onChange]);

  if (options.length === 0) {
    return null;
  }
  return (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={selectedDisplay}
      options={selectOptions}
      onChange={handleChange}
      placeholder={defaultLabel}
      emptyText={t("goals.form.thinkingEmpty")}
      searchable={options.length > 8}
      title={label}
      size={size}
      testID={testID}
      triggerTestID={`${testID}-trigger`}
    />
  );
}

function ProviderOptionItem({
  option,
  selected,
  active,
  onPress,
  serverId,
}: SelectFieldRenderOptionInput<string> & { serverId: string }): ReactElement {
  const leadingSlot = useMemo<ReactNode>(
    () => (option.value ? <ProviderGlyph provider={option.value} serverId={serverId} /> : null),
    [option.value, serverId],
  );
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

export function ProviderGlyph({ provider, serverId }: { provider: string; serverId: string }) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => ({
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  settingText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  settingLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  settingHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  settingControl: {
    flexShrink: 0,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
