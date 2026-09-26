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
} from "react-native";
import type { PluginIconProps } from "./contracts.js";

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

export declare const Icon: ComponentType<PluginIconProps>;
/**
 * A host-managed full-window layer. The host owns focus, Escape, Android Back, and stacking, so
 * an overlay opened inside another closes first, and Command Center or a host menu can open over
 * it without a focus fight. Undefined on older hosts.
 */
export declare const Overlay: ComponentType<OverlayProps>;
export declare const Modal: ModalComponent;
export declare function useToast(): ToastApi;
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;

export type { PluginIconProps } from "./contracts.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/**
 * Opens the platform image picker: the photo library on iOS and Android, a file chooser on the
 * web. Resolves `[]` when the user cancels. Undefined on older hosts.
 */
export declare function pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
/**
 * Opens the platform file chooser for any kind of file: the document picker on iOS and Android,
 * a file chooser on the web and desktop. Files come as readers rather than bytes, so a plugin
 * reads a large file a chunk at a time. Resolves `[]` when the user cancels. Undefined on older
 * hosts.
 */
export declare function pickFiles(options?: PickFilesOptions): Promise<PickedFile[]>;
/**
 * Opens the host's zoomable image viewer over everything, including the plugin's own `Overlay`,
 * with previous/next paging when there is more than one image. Throws when `images` is empty.
 * Undefined on older hosts.
 */
export declare function openImagePreview(options: ImagePreviewOptions): void;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;
