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

export interface OverlayProps {
  open: boolean;
  /**
   * Escape, Android Back, and a press outside the content ask to close. Keep `open` true to
   * refuse, or close a menu inside the overlay first.
   */
  onClose(): void;
  /** `"dim"` (default) darkens the page; `"clear"` leaves it as it is, for anchored menus. */
  backdrop?: "dim" | "clear";
  /** Announced by screen readers when the overlay takes focus. */
  accessibilityLabel?: string;
  /**
   * Laid out over the whole window, above every host surface. Position boxes and menus
   * absolutely; the empty area passes presses through to the backdrop.
   */
  children: ReactNode;
}

/**
 * A host-managed full-window layer. The host owns focus, Escape, Android Back, and stacking, so
 * an overlay opened inside another closes first, and Command Center or a host menu can open over
 * it without a focus fight. Undefined on older hosts.
 */
export declare const Overlay: ComponentType<OverlayProps>;

export interface PickImagesOptions {
  /** Default false. */
  multiple?: boolean;
  /** Most images one pick returns when `multiple` is true. */
  limit?: number;
}

export interface PickedImage {
  /** Displayable by `Image`: a local file on iOS and Android, a `data:` URI on the web. */
  uri: string;
  /** Base64-encoded bytes, without a `data:` prefix. */
  base64: string;
  mimeType: string;
  /** Undefined when the platform does not report one. */
  fileName?: string;
  width: number;
  height: number;
  /** Decoded byte count of `base64`. */
  byteLength: number;
}

/**
 * Opens the platform image picker: the photo library on iOS and Android, a file chooser on the
 * web. Resolves `[]` when the user cancels. Undefined on older hosts.
 */
export declare function pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;

export interface PickFilesOptions {
  /** Default false. */
  multiple?: boolean;
}

export interface PickedFile {
  fileName: string;
  /**
   * Inferred from the name when the platform does not report one; `application/octet-stream`
   * as a last resort.
   */
  mimeType: string;
  byteLength: number;
  /**
   * Base64 of up to `length` bytes starting at `offset`, fewer at the end of the file and empty
   * past it. Rejects when the file can no longer be read.
   */
  readBase64(offset: number, length: number): Promise<string>;
}

/**
 * Opens the platform file chooser for any kind of file: the document picker on iOS and Android,
 * a file chooser on the web and desktop. Files come as readers rather than bytes, so a plugin
 * reads a large file a chunk at a time. Resolves `[]` when the user cancels. Undefined on older
 * hosts.
 */
export declare function pickFiles(options?: PickFilesOptions): Promise<PickedFile[]>;

export interface ImagePreviewItem {
  /** Anything `Image` can show; plugins pass `data:` URIs. */
  uri: string;
  /** Shown under the image. */
  name?: string;
}

export interface ImagePreviewOptions {
  images: readonly ImagePreviewItem[];
  /** Which image opens first. Default 0. */
  index?: number;
}

/**
 * Opens the host's zoomable image viewer over everything, including the plugin's own `Overlay`,
 * with previous/next paging when there is more than one image. Throws when `images` is empty.
 * Undefined on older hosts.
 */
export declare function openImagePreview(options: ImagePreviewOptions): void;
