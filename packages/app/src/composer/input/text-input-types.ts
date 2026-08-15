import type { TextInputProps } from "react-native";
import type { NativePastedFile } from "@/composer/native-pasted-image";

export interface ComposerTextInputHandle {
  focus: () => void;
  blur: () => void;
  getText: () => string;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  getNativeRef?: () => unknown;
}

export interface ComposerTextInputProps extends Omit<
  TextInputProps,
  "defaultValue" | "onChangeText" | "value"
> {
  text: string;
  onChangeText: (text: string) => void;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  onPasteError?: (message: string) => void;
}
