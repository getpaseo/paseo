import type { TextInputProps } from "react-native";
import type { NativePastedFile } from "@/composer/native-pasted-image";

/** Stable for the mounted editor lifetime; reset() owns any inner input replacement. */
export interface EditingTextInputHandle {
  focus(): void;
  blur(): void;
  isFocused(): boolean;
  getText(): string;
  replaceText(text: string, selection?: { start: number; end: number }): void;
  setSelection(selection: { start: number; end: number }): void;
  /** Clear the editor and reset its intrinsic layout, preserving focus intent. */
  reset(): void;
  getNativeRef(): unknown;
}

export interface EditingTextInputProps extends Omit<
  TextInputProps,
  "defaultValue" | "onChangeText" | "value"
> {
  initialValue?: string;
  onChangeText?: (text: string) => void;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  onPasteError?: (message: string) => void;
  /** Re-render the native input leaf on each edit so multiline inputs re-measure height. Defaults to true. */
  remeasureOnEdit?: boolean;
  variant?: "default" | "bottom-sheet";
}
