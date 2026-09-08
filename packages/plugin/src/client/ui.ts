import type { ComponentType, ReactNode, Ref } from "react";

export interface SettingsSectionProps {
  title: string;
  info?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  testID?: string;
}
export interface SettingsRowProps {
  label: string;
  hint?: string;
  error?: string | null;
  children?: ReactNode;
  testID?: string;
}
export interface SettingsSwitchProps extends SettingsRowProps {
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
}
export interface SettingsSelectProps<Value extends string = string> extends SettingsRowProps {
  value: Value;
  options: readonly { label: string; value: Value }[];
  onValueChange(value: Value): void;
  disabled?: boolean;
}
export interface SettingsInputHandle {
  focus(): void;
  blur(): void;
  getText(): string;
  replaceText(text: string): void;
}
export interface SettingsInputProps extends SettingsRowProps {
  initialValue?: string;
  onChangeText(text: string): void;
  placeholder?: string;
  disabled?: boolean;
  secureTextEntry?: boolean;
  ref?: Ref<SettingsInputHandle>;
}
export interface SettingsActionProps extends SettingsRowProps {
  actionLabel: string;
  onPress(): void;
  disabled?: boolean;
}
export declare const SettingsGroup: ComponentType<SettingsSectionProps>;
export declare const SettingsSection: ComponentType<SettingsSectionProps>;
export declare const SettingsCard: ComponentType<{ children: ReactNode; testID?: string }>;
export declare const SettingsRow: ComponentType<SettingsRowProps>;
export declare const SettingsSwitch: ComponentType<SettingsSwitchProps>;
export declare function SettingsSelect<Value extends string>(
  props: SettingsSelectProps<Value>,
): ReactNode;
export declare const SettingsInput: ComponentType<SettingsInputProps>;
export declare const SettingsAction: ComponentType<SettingsActionProps>;
