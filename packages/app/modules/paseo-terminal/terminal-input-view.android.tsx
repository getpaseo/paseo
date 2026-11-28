import { requireNativeView } from "expo";
import { forwardRef, useCallback, type Ref } from "react";
import type { ViewProps } from "react-native";
import type {
  PaseoTerminalInputKeyEvent,
  PaseoTerminalInputViewHandle,
  PaseoTerminalInputViewProps,
} from "./terminal-input-view";

export type {
  PaseoTerminalInputKeyEvent,
  PaseoTerminalInputViewHandle,
  PaseoTerminalInputViewProps,
};

interface NativePaseoTerminalInputViewProps extends ViewProps {
  ref?: Ref<PaseoTerminalInputViewHandle>;
  onTerminalInput?: (event: { nativeEvent: { data: string } }) => void;
  onTerminalKey?: (event: { nativeEvent: PaseoTerminalInputKeyEvent }) => void;
  onFocusChange?: (event: { nativeEvent: { focused: boolean } }) => void;
}

const NativePaseoTerminalInputView = requireNativeView<NativePaseoTerminalInputViewProps>(
  "PaseoTerminal",
  "PaseoTerminalInputView",
);

export const PaseoTerminalInputView = forwardRef<
  PaseoTerminalInputViewHandle,
  PaseoTerminalInputViewProps
>(function PaseoTerminalInputView(
  { onTerminalInput, onTerminalKey, onFocusChange, ...props },
  ref,
) {
  const handleTerminalInput = useCallback(
    (event: { nativeEvent: { data: string } }) => onTerminalInput?.(event.nativeEvent.data),
    [onTerminalInput],
  );
  const handleTerminalKey = useCallback(
    (event: { nativeEvent: PaseoTerminalInputKeyEvent }) => onTerminalKey?.(event.nativeEvent),
    [onTerminalKey],
  );
  const handleFocusChange = useCallback(
    (event: { nativeEvent: { focused: boolean } }) => onFocusChange?.(event.nativeEvent.focused),
    [onFocusChange],
  );

  return (
    <NativePaseoTerminalInputView
      {...props}
      ref={ref}
      onTerminalInput={handleTerminalInput}
      onTerminalKey={handleTerminalKey}
      onFocusChange={handleFocusChange}
    />
  );
});
