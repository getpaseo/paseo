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

export declare const Icon: ComponentType<PluginIconProps>;
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
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

/** A decoded frame retained by the host until present() or release(). */
export interface EncodedVideoFrame {
  id: number;
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
}

export interface EncodedVideoConfig {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  descriptionBase64?: string;
  optimizeForLatency: boolean;
}

export interface EncodedVideoChunk {
  type: "key" | "delta";
  timestamp: number;
  dataBase64: string;
}

export interface EncodedVideoHandle {
  /** Replaces the decoder and releases all retained frames. */
  configure(config: EncodedVideoConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  reset(): void;
  /** Resolves after drawing this frame. Rejects on reset, unmount, or host failure. */
  present(frameId: number): Promise<void>;
  release(frameId: number): void;
}

export interface EncodedVideoProps {
  style?: StyleProp<ViewStyle>;
  onReady(): void;
  onFrame(frame: EncodedVideoFrame): void;
  /** One acknowledgement for each submitted chunk, even if it produces no frame. */
  onDequeue(): void;
  onError(error: Error): void;
}

/** Host-owned Android WebCodecs canvas. It receives bytes, never URLs or credentials.
 * Input remains caller-owned. Revoke input before present(), then admit it only after
 * the promise resolves and the original source identity is still current.
 * Other platforms report unsupported; browser plugins can use WebCodecs directly. */
export declare const EncodedVideo: ForwardRefExoticComponent<
  EncodedVideoProps & RefAttributes<EncodedVideoHandle>
>;
