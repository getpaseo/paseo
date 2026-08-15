import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
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

export type TerminalInputFocusRequest = "focus" | "refocus" | "none";

export interface TerminalInputHandle {
  focus: () => void;
  showKeyboard: () => void;
  blur: () => void;
}

interface TerminalInputProps {
  isKeyboardVisible: boolean;
  onFocus?: () => void;
  onInput?: (data: string) => void;
  onTerminalKey?: (key: NativeTerminalKey) => void;
  style?: StyleProp<TextStyle>;
}

// Hangul jamo, compatibility jamo, and precomposed syllables. A Korean IME
// commits every syllable except the one it is still composing, so a composition
// edit only ever rewrites the final character of the buffer.
const HANGUL_PATTERN = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]/;

// Only ASCII travels the keypress path. An IME script reports the jamo it is
// composing, which the text-change diff below immediately contradicts, so
// forwarding both would put two conflicting characters on the wire.
function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key <= "~";
}

function getCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * What the terminal receives for an edit that is not a plain append.
 *
 * A Korean IME rewrites the syllable it is composing in place — `ㅎ` becomes
 * `하` becomes `한`. None of those are appends, so forwarding appends alone
 * drops every keystroke after the first jamo and Korean cannot be typed at all.
 * Rub out the rewritten character and send the replacement.
 *
 * Only a single trailing character qualifies. A wider rewrite is an autocorrect
 * or suggestion replacement, which stays swallowed: the hidden input can edit
 * text the terminal has already committed, and the terminal cannot take it back.
 */
function resolveCompositionEdit(previousText: string, text: string): string {
  const commonPrefixLength = getCommonPrefixLength(previousText, text);
  const removed = previousText.slice(commonPrefixLength);
  const inserted = text.slice(commonPrefixLength);
  if (removed.length !== 1 || inserted.length === 0) {
    return "";
  }
  if (!HANGUL_PATTERN.test(removed) || !HANGUL_PATTERN.test(inserted)) {
    return "";
  }
  return `\x7f${inserted}`;
}

export function resolveTerminalInputFocusRequest(input: {
  isInputFocused: boolean;
  isKeyboardVisible: boolean;
}): TerminalInputFocusRequest {
  if (!input.isInputFocused) {
    return "focus";
  }
  return input.isKeyboardVisible ? "none" : "refocus";
}

export function createTerminalTextInputState(): TerminalTextInputState {
  let previousText = "";
  let submittedText: string | null = null;
  // A swallowed replacement leaves the terminal holding text the buffer no
  // longer describes. A composition rubout deletes from the terminal, so it
  // would delete whatever is actually sitting there rather than the character
  // the buffer thinks it is replacing. Stay off until the line is cleared.
  let replacementDesynced = false;

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
          replacementDesynced = false;
          return { data: "", shouldClear: false };
        }
      }

      if (text.length === 0) {
        previousText = "";
        replacementDesynced = false;
        return { data: "", shouldClear: false };
      }

      if (text.includes("\n") || text.includes("\r")) {
        previousText = "";
        replacementDesynced = false;
        return { data: "", shouldClear: true };
      }

      if (!text.startsWith(previousText)) {
        const compositionEdit = replacementDesynced
          ? ""
          : resolveCompositionEdit(previousText, text);
        if (compositionEdit === "") {
          replacementDesynced = true;
        }
        previousText = text;
        return { data: compositionEdit, shouldClear: false };
      }

      const appendedText = text.slice(previousText.length);
      previousText = text;
      return {
        data: appendedText,
        shouldClear: false,
      };
    },
    reset(): void {
      previousText = "";
      replacementDesynced = false;
    },
  };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ isKeyboardVisible, onFocus, onInput, onTerminalKey, style }, ref) {
    const inputRef = useRef<TextInput>(null);
    const isFocusedRef = useRef(false);
    const pendingFocusFrameRef = useRef<number | null>(null);
    const inputState = useMemo(() => createTerminalTextInputState(), []);
    const inputStyle = useMemo(() => [styles.input, style], [style]);

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

      // Keep the native IME buffer aligned with the terminal. Some keyboards
      // do not emit a text change when a clipboard item replaces identical
      // stale input, so clear the buffer even when focus is already correct.
      resetNativeInput();

      const focusRequest = resolveTerminalInputFocusRequest({
        isInputFocused: isFocusedRef.current || input.isFocused(),
        isKeyboardVisible,
      });
      if (focusRequest === "none") {
        return;
      }

      if (focusRequest === "focus") {
        input.focus();
        return;
      }

      input.blur();
      isFocusedRef.current = false;
      input.focus();
      pendingFocusFrameRef.current = requestAnimationFrame(() => {
        pendingFocusFrameRef.current = null;
        inputRef.current?.focus();
      });
    }, [clearPendingFocus, isKeyboardVisible, resetNativeInput]);

    const blurNativeInput = useCallback(() => {
      clearPendingFocus();
      inputRef.current?.blur();
      isFocusedRef.current = false;
      resetNativeInput();
    }, [clearPendingFocus, resetNativeInput]);

    const focusNativeInput = useCallback(() => {
      showNativeKeyboard();
    }, [showNativeKeyboard]);

    useEffect(() => clearPendingFocus, [clearPendingFocus]);

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
          resetNativeInput();
        }
      },
      [inputState, onInput, resetNativeInput],
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
          resetNativeInput();
        }
      },
      [inputState, onInput, onTerminalKey, resetNativeInput],
    );

    return (
      // No keyboardType prop: `ascii-capable` drops the globe key on iOS, which
      // is how you reach the Korean layout. Terminal safety comes from
      // autoCorrect/spellCheck/autoCapitalize being off, not from the layout.
      <TextInput
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
