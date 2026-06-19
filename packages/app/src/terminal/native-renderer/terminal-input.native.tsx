import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Keyboard,
  StyleSheet,
  TextInput,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import { resolveNativeTerminalKey, type NativeTerminalKey } from "./terminal-key-events";

export const TERMINAL_INPUT_CONTEXT_MENU_HIDDEN = true;
export const TERMINAL_INPUT_HITBOX_SIZE = 1;

export interface TerminalTextInputChange {
  data: string;
  key?: NativeTerminalKey;
  shouldClear: boolean;
}

export interface TerminalTextInputState {
  receiveKeyPress: (key: string) => TerminalTextInputChange;
  receiveTextChange: (text: string) => TerminalTextInputChange;
  reset: () => void;
}

export type TerminalInputFocusRequest = "focus" | "refocus";

export interface TerminalInputHandle {
  focus: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

interface TerminalInputProps {
  onFocus?: () => void;
  onInput?: (data: string) => void;
  onTerminalKey?: (key: NativeTerminalKey) => void;
  style?: StyleProp<TextStyle>;
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\x7f";
}

export function resolveTerminalInputFocusRequest(input: {
  isInputFocused: boolean;
}): TerminalInputFocusRequest {
  return input.isInputFocused ? "refocus" : "focus";
}

export function createTerminalTextInputState(): TerminalTextInputState {
  let previousText = "";
  let isClearPending = false;
  let submittedText: string | null = null;

  return {
    receiveKeyPress(key: string): TerminalTextInputChange {
      const terminalKey = resolveNativeTerminalKey(key);
      if (terminalKey) {
        return { data: "", key: terminalKey, shouldClear: false };
      }
      if (key === "Backspace") {
        previousText = previousText.slice(0, -1);
        return { data: "\x7f", shouldClear: false };
      }
      if (key === "Enter" || key === "Return" || key === "return") {
        submittedText = previousText;
        return { data: "\r", shouldClear: true };
      }
      if (isPrintableKey(key)) {
        previousText += key;
        isClearPending = false;
        return { data: key, shouldClear: false };
      }
      return { data: "", shouldClear: false };
    },
    receiveTextChange(text: string): TerminalTextInputChange {
      if (submittedText !== null) {
        const lateSubmitText = `${submittedText}\n`;
        submittedText = null;
        if (text === lateSubmitText) {
          previousText = "";
          isClearPending = false;
          return { data: "", shouldClear: false };
        }
      }

      if (text.length === 0) {
        previousText = "";
        isClearPending = false;
        return { data: "", shouldClear: false };
      }

      if (text.includes("\n") || text.includes("\r")) {
        previousText = "";
        isClearPending = false;
        return { data: "", shouldClear: true };
      }

      if (!text.startsWith(previousText)) {
        if (isClearPending) {
          const data = text;
          previousText = text;
          isClearPending = false;
          return { data, shouldClear: false };
        }

        previousText = text;
        return { data: "", shouldClear: false };
      }

      const appendedText = text.slice(previousText.length);
      previousText = text;
      isClearPending = false;
      return {
        data: appendedText,
        shouldClear: false,
      };
    },
    reset(): void {
      previousText = "";
      isClearPending = false;
    },
  };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ onFocus, onInput, onTerminalKey, style }, ref) {
    const inputRef = useRef<TextInput>(null);
    const isFocusedRef = useRef(false);
    const pendingFocusFrameRef = useRef<number | null>(null);
    const shouldRefocusAfterClearRef = useRef(false);
    const inputState = useMemo(() => createTerminalTextInputState(), []);
    const inputStyle = useMemo(() => [styles.input, style], [style]);
    const [inputEpoch, setInputEpoch] = useState(0);

    const clearPendingFocus = useCallback(() => {
      if (pendingFocusFrameRef.current === null) {
        return;
      }
      cancelAnimationFrame(pendingFocusFrameRef.current);
      pendingFocusFrameRef.current = null;
    }, []);

    const resetNativeInput = useCallback(() => {
      inputState.reset();
      inputRef.current?.clear();
    }, [inputState]);

    const showNativeKeyboard = useCallback(() => {
      clearPendingFocus();
      const input = inputRef.current;
      if (!input) {
        return;
      }

      input.blur();
      isFocusedRef.current = false;
      resetNativeInput();
      input.focus();
      pendingFocusFrameRef.current = requestAnimationFrame(() => {
        pendingFocusFrameRef.current = null;
        inputRef.current?.focus();
      });
    }, [clearPendingFocus, resetNativeInput]);

    const blurNativeInput = useCallback(() => {
      clearPendingFocus();
      inputRef.current?.blur();
      isFocusedRef.current = false;
      resetNativeInput();
    }, [clearPendingFocus, resetNativeInput]);

    const focusNativeInput = useCallback(() => {
      clearPendingFocus();
      const input = inputRef.current;
      if (!input) {
        return;
      }

      const focusRequest = resolveTerminalInputFocusRequest({
        isInputFocused: isFocusedRef.current || input.isFocused(),
      });
      if (focusRequest === "focus") {
        input.focus();
        return;
      }

      showNativeKeyboard();
    }, [clearPendingFocus, showNativeKeyboard]);

    useEffect(() => {
      const subscription = Keyboard.addListener("keyboardDidHide", () => {
        if (!isFocusedRef.current) {
          return;
        }
        blurNativeInput();
      });
      return () => subscription.remove();
    }, [blurNativeInput]);

    useEffect(() => clearPendingFocus, [clearPendingFocus]);

    useEffect(() => {
      if (!shouldRefocusAfterClearRef.current) {
        return;
      }
      shouldRefocusAfterClearRef.current = false;
      const frame = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }, [inputEpoch]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          focusNativeInput();
        },
        showKeyboard: () => {
          showNativeKeyboard();
        },
        blur: () => {
          blurNativeInput();
        },
      }),
      [blurNativeInput, focusNativeInput, showNativeKeyboard],
    );

    const handleFocus = useCallback(() => {
      isFocusedRef.current = true;
      onFocus?.();
    }, [onFocus]);

    const handleBlur = useCallback(() => {
      isFocusedRef.current = false;
      resetNativeInput();
    }, [resetNativeInput]);

    const handleChangeText = useCallback(
      (text: string) => {
        const change = inputState.receiveTextChange(text);
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          inputState.reset();
          shouldRefocusAfterClearRef.current = true;
          setInputEpoch((current) => current + 1);
        }
      },
      [inputState, onInput],
    );

    const handleKeyPress = useCallback(
      (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
        const change = inputState.receiveKeyPress(event.nativeEvent.key);
        if (change.key) {
          onTerminalKey?.(change.key);
        }
        if (change.data.length > 0) {
          onInput?.(change.data);
        }
        if (change.shouldClear) {
          inputState.reset();
          shouldRefocusAfterClearRef.current = true;
          setInputEpoch((current) => current + 1);
        }
      },
      [inputState, onInput, onTerminalKey],
    );

    return (
      <TextInput
        key={inputEpoch}
        ref={inputRef}
        accessibilityLabel="Terminal input"
        accessible={true}
        autoCapitalize="none"
        autoCorrect={false}
        caretHidden={true}
        contextMenuHidden={TERMINAL_INPUT_CONTEXT_MENU_HIDDEN}
        defaultValue=""
        blurOnSubmit={false}
        importantForAutofill="no"
        keyboardType="ascii-capable"
        multiline={true}
        onChangeText={handleChangeText}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        showSoftInputOnFocus={true}
        spellCheck={false}
        style={inputStyle}
        testID="terminal-native-input"
        textContentType="none"
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    backgroundColor: "transparent",
    color: "transparent",
    height: TERMINAL_INPUT_HITBOX_SIZE,
    left: 0,
    opacity: 0.01,
    padding: 0,
    position: "absolute",
    top: 0,
    width: TERMINAL_INPUT_HITBOX_SIZE,
  },
});
