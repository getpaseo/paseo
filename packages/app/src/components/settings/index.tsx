import {
  Children,
  isValidElement,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  SettingsRowProps,
  SettingsSwitchProps,
  SettingsSelectProps,
  SettingsInputProps,
  SettingsActionProps,
} from "@getpaseo/plugin/client/ui";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
export { SettingsGroup } from "./headings/settings-group";
export { SettingsSection } from "./headings/settings-section";

export function SettingsCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={settingsStyles.card} testID={testID}>
      {Children.toArray(children).map((child, index) => (
        <View
          key={isValidElement(child) ? child.key : index}
          style={index ? settingsStyles.rowBorder : undefined}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

export function SettingsRow({ label, hint, error, children, testID }: SettingsRowProps) {
  const compact = useIsCompactFormFactor();
  const rowStyle = useMemo(() => [settingsStyles.row, compact && styles.compactRow], [compact]);
  return (
    <View style={rowStyle} testID={testID}>
      <View style={styles.label}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      {children ? <View style={styles.control}>{children}</View> : null}
    </View>
  );
}

export function SettingsSwitch({ value, onValueChange, disabled, ...row }: SettingsSwitchProps) {
  return (
    <SettingsRow {...row}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={row.label}
      />
    </SettingsRow>
  );
}

function SettingsOption<Value extends string>({
  option,
  selected,
  onValueChange,
}: {
  option: { label: string; value: Value };
  selected: boolean;
  onValueChange(value: Value): void;
}) {
  const select = useCallback(() => onValueChange(option.value), [onValueChange, option.value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {option.label}
    </DropdownMenuItem>
  );
}

export function SettingsSelect<Value extends string>({
  value,
  options,
  onValueChange,
  disabled,
  ...row
}: SettingsSelectProps<Value>) {
  return (
    <SettingsRow {...row}>
      <DropdownMenu>
        <DropdownTrigger
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={row.label}
        >
          <Text style={styles.value}>
            {options.find((option) => option.value === value)?.label ?? value}
          </Text>
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {options.map((option) => (
            <SettingsOption
              key={option.value}
              option={option}
              selected={option.value === value}
              onValueChange={onValueChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

export function SettingsInput({
  initialValue,
  onChangeText,
  placeholder,
  disabled,
  secureTextEntry,
  ref,
  ...row
}: SettingsInputProps) {
  const compact = useIsCompactFormFactor();
  const input = useRef<EditingTextInputHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      blur: () => input.current?.blur(),
      getText: () => input.current?.getText() ?? "",
      replaceText: (text) => input.current?.replaceText(text),
    }),
    [],
  );
  return (
    <SettingsRow {...row}>
      <FormTextInput
        ref={input}
        initialValue={initialValue}
        onChangeText={onChangeText}
        placeholder={placeholder}
        editable={!disabled}
        secureTextEntry={secureTextEntry}
        accessibilityLabel={row.label}
        size={compact ? "md" : "sm"}
        style={styles.input}
      />
    </SettingsRow>
  );
}

export function SettingsAction({ actionLabel, onPress, disabled, ...row }: SettingsActionProps) {
  return (
    <SettingsRow {...row}>
      <Button variant="outline" size="sm" onPress={onPress} disabled={disabled}>
        {actionLabel}
      </Button>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactRow: { flexWrap: "wrap", gap: theme.spacing[3] },
  label: { flexGrow: 1, flexShrink: 1, flexBasis: 160, marginRight: theme.spacing[3] },
  control: { flexShrink: 1, maxWidth: "100%" },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  input: { minWidth: 180 },
}));
