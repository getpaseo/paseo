import { forwardRef, type Ref } from "react";
import type { ViewProps } from "react-native";

export interface PaseoTerminalInputViewHandle {
  focusInput: () => Promise<void>;
  showKeyboard: () => Promise<void>;
  blurInput: () => Promise<void>;
}

export interface PaseoTerminalInputKeyEvent {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export interface PaseoTerminalInputViewProps extends ViewProps {
  onTerminalInput?: (data: string) => void;
  onTerminalKey?: (event: PaseoTerminalInputKeyEvent) => void;
  onFocusChange?: (focused: boolean) => void;
}

export const PaseoTerminalInputView = forwardRef<
  PaseoTerminalInputViewHandle,
  PaseoTerminalInputViewProps
>(function PaseoTerminalInputView(
  _props: PaseoTerminalInputViewProps,
  _ref: Ref<PaseoTerminalInputViewHandle>,
) {
  return null;
});
