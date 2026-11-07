import type {
  ComponentType,
  FunctionComponent,
  ReactNode,
  ForwardRefExoticComponent,
  RefAttributes,
  ReactElement,
  Ref,
} from "react";
import type {
  StyleProp,
  ViewStyle,
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatList as NativeFlatList,
  FlatListProps,
  TextInput as NativeTextInput,
  TextInputProps,
  TextProps,
} from "react-native";
import type { PluginIconProps } from "../icons.js";
import type { PluginIcon } from "./contracts.js";

export interface ModalProps {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

export interface ModalContentProps {
  children: ReactNode;
  /** Paint the full body below the header. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the default 24px padding and 16px gap. Safe-area clearance stays host-owned. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Default true. Set false for a bounded body with your own ScrollView or FlatList. */
  scrollable?: boolean;
}

export interface ModalComponent extends FunctionComponent<ModalProps> {
  Content: ComponentType<ModalContentProps>;
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

/** Renders a Lucide icon by `name`, or any plugin icon by `icon`. An unusable icon renders nothing. */
export type IconProps = Partial<PluginIconProps> &
  ({ name: string; icon?: never } | { icon: PluginIcon; name?: never });

export declare const Icon: ComponentType<IconProps>;
export declare const Modal: ModalComponent;
export declare function useToast(): ToastApi;
export interface StreamedTextProps extends Omit<TextProps, "children"> {
  text: string;
  phase: "streaming" | "complete";
}
/** Plain assistant text with host-owned streaming pacing and typography. */
export declare const StreamedText: ComponentType<StreamedTextProps>;

export type { PluginIconProps } from "../icons.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

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
// COMPAT(pluginSettingsGroup): added in v0.13.0, remove after 2027-04-20
/** @deprecated Use SettingsSection for plugin settings headings. */
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

export interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
  onError?: (error: unknown) => void;
}
export declare const ExternalLink: ComponentType<ExternalLinkProps>;

export type SidebarIcon = PluginIcon;
export interface SidebarRowProps {
  /**
   * Tells rows of one item apart when the item renders several: "bot-2". Unique within the item.
   * Omit it when the item renders one row.
   */
  id?: string;
  /** A Lucide icon name, inline SVG, or a component. */
  icon?: SidebarIcon;
  /** Defaults to the item's registered title. */
  label?: string;
  onPress(): void;
  active?: boolean;
  /** Right slot. Renders beside the row's pressable, so a button here presses on its own. */
  trailing?: ReactNode;
}
/** A sidebar navigation row. Render it from a sidebar item's `Component`. */
export declare const SidebarRow: ComponentType<SidebarRowProps>;
/** A line between groups of rows. Render it from a sidebar item's `Component`. */
export declare const SidebarSeparator: ComponentType;

/** Paseo's loading state. Fills the panel; the panel decides when to show it. */
export declare const Loading: ComponentType;

/** Render a local document URL in an isolated frame. */
export declare const DocumentFrame: ComponentType<{ url: string; testID?: string }>;

export interface MarkdownProps {
  children: string;
}

/** Renders Markdown using Paseo’s theme, selection, and link behavior. */
export declare const Markdown: ComponentType<MarkdownProps>;
