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
import { ControlSizeProvider } from "@/components/ui/control-size";
import { ExternalLink, type ExternalLinkProps } from "@/components/ui/external-link";
import { useSettingsRowLayout } from "./row-density";
import { SettingsRowTitle } from "./row-label";
export { SettingsRowChildren } from "./row-children";
export { SettingsGroup } from "./headings/settings-group";
export { SettingsSection } from "./headings/settings-section";
export { SettingsCollapsibleRow } from "./collapsible-row";
export { SettingsDetailRow } from "./detail-row";
export type { SettingsRowHintStatus } from "./row-header";
export { SettingsAddRow } from "./add-row";
export { SettingsBackLink, SettingsDetailHeader } from "./detail-header";
export { SettingsInfoTip } from "./headings/settings-info-tip";
export { MenuSettingsRows } from "./row-density";

/**
 * What app screens can add to a plugin-facing row: an accessory beside the label, such as an info
 * tip, an icon before the label, and a link to a page outside the app under the hint.
 */
interface AppRowExtras {
  labelAccessory?: ReactNode;
  /** An icon before the label, such as the thing the row is about. */
  leading?: ReactNode;
  /** A page outside the app that helps with this row, drawn under the hint as "Label ↗". */
  link?: Pick<ExternalLinkProps, "href" | "label" | "accessibilityLabel">;
}

interface AppSettingsRowProps extends Omit<SettingsRowProps, "hint">, AppRowExtras {
  hint?: ReactNode;
}

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

export function SettingsRow({
  label,
  leading,
  labelAccessory,
  hint,
  link,
  error,
  children,
  testID,
}: AppSettingsRowProps) {
  const compact = useIsCompactFormFactor();
  const layout = useSettingsRowLayout();
  const rowStyle = useMemo(() => [layout.row, compact && styles.compactRow], [compact, layout]);
  return (
    <View style={rowStyle} testID={testID}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.label}>
        <SettingsRowTitle label={label} accessory={labelAccessory} />
        {typeof hint === "string" ? <Text style={layout.hint}>{hint}</Text> : hint}
        {link ? (
          <View style={styles.link}>
            <ExternalLink {...link} />
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      {children ? (
        <View style={styles.control}>
          <ControlSizeProvider size={layout.controlSize}>{children}</ControlSizeProvider>
        </View>
      ) : null}
    </View>
  );
}

/** A switch row. App screens may pass `null` while the value is not known yet; see `Switch`. */
export function SettingsSwitch({
  value,
  onValueChange,
  disabled,
  ...row
}: Omit<SettingsSwitchProps, "onValueChange" | "value"> &
  Partial<Pick<SettingsSwitchProps, "onValueChange">> &
  AppRowExtras & { value: boolean | null }) {
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
}: SettingsSelectProps<Value> & AppRowExtras) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  return (
    <SettingsRow {...row}>
      <DropdownMenu>
        <DropdownTrigger
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${row.label}: ${selectedLabel}`}
        >
          {selectedLabel}
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
}: SettingsInputProps & AppRowExtras) {
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
        size={compact ? "md" : undefined}
        style={styles.input}
      />
    </SettingsRow>
  );
}

export function SettingsAction({
  actionLabel,
  onPress,
  disabled,
  ...row
}: SettingsActionProps & AppRowExtras) {
  return (
    <SettingsRow {...row}>
      <Button variant="outline" onPress={onPress} disabled={disabled}>
        {actionLabel}
      </Button>
    </SettingsRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A control that wraps under the label gets space above it. Across the row, the leading slot and
  // the label already carry their own margins, so a column gap would double them.
  compactRow: { flexWrap: "wrap", rowGap: theme.spacing[3] },
  // The same leading slot as `SettingsRowHeader`, so icons and labels share rails across row kinds.
  leading: { marginRight: theme.spacing[3], alignItems: "center", justifyContent: "center" },
  label: { flexGrow: 1, flexShrink: 1, flexBasis: 160, marginRight: theme.spacing[3] },
  link: { alignItems: "flex-start", marginTop: theme.spacing[1] },
  control: { flexShrink: 1, maxWidth: "100%" },
  input: { minWidth: 180 },
}));
