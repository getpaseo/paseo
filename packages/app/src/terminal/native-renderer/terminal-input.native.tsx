import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import {
  StyleSheet,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputKeyPressEventData,
  type TextStyle,
} from "react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
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

function getCommonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * The terminal edit for a hidden input whose buffer changed.
 *
 * Android keyboards rewrite the buffer in place instead of appending to it: a
 * tapped Gboard suggestion replaces the word, a swipe across Backspace drops a
 * whole word in one edit, space-bar cursor control inserts mid-line, and CJK
 * IMEs rewrite the composing syllable on every jamo (`ㅎ` -> `하` -> `한`).
 * Diff the buffer instead of guessing which of those happened: rub out what it
 * dropped, then send what it gained. A plain append rubs out nothing, so
 * ordinary typing is one write.
 *
 * The diff is also the recovery path. The anticipated buffer drifts whenever
 * the keyboard edits text it never reported, and measuring the next change
 * against whatever the buffer actually holds absorbs that drift.
 *
 * Rubouts stay bounded by the buffer, and the buffer resets whenever the
 * terminal takes the line (submit, paste, blur, refocus), so an edit can only
 * take back characters this buffer put on the wire.
 */
function resolveBufferEdit(previousText: string, text: string): string {
  const previousCharacters = Array.from(previousText);
  const nextCharacters = Array.from(text);
  const commonPrefixLength = getCommonPrefixLength(previousCharacters, nextCharacters);
  const rubouts = previousCharacters.length - commonPrefixLength;
  return `${"\x7f".repeat(rubouts)}${nextCharacters.slice(commonPrefixLength).join("")}`;
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

  return {
    receiveKeyPress(key: string): TerminalTextInputChange {
      const terminalKey = resolveNativeTerminalKey(key);
      if (terminalKey) {
        return { data: "", key: terminalKey, shouldClear: false };
      }
      if (key === "Backspace") {
        // A soft-keyboard Backspace deletes one character from what the user
        // can see, which is the terminal. Forward it whatever the buffer
        // holds; the text change that follows rubs out anything else it took.
        previousText = Array.from(previousText).slice(0, -1).join("");
        return { data: "\x7f", shouldClear: false };
      }
      if (key === "Enter" || key === "Return" || key === "return") {
        submittedText = previousText;
        return { data: "\r", shouldClear: true };
      }
      // Only ASCII travels the keypress path. An IME reports the jamo it is
      // composing, which the text-change diff immediately contradicts, so
      // forwarding both would put two conflicting characters on the wire.
      if (key.length === 1 && key >= " " && key <= "~") {
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
          return { data: "", shouldClear: false };
        }
      }

      // Our own clear echoes back as an empty change, and `reset` has already
      // emptied the buffer by then, so this only fires when the keyboard wiped
      // text we still anticipate. Forget it rather than rub out a line the
      // terminal may have moved on from.
      if (text.length === 0) {
        previousText = "";
        return { data: "", shouldClear: false };
      }

      if (text.includes("\n") || text.includes("\r")) {
        previousText = "";
        return { data: "", shouldClear: true };
      }

      const edit = resolveBufferEdit(previousText, text);
      previousText = text;
      return { data: edit, shouldClear: false };
    },
    reset(): void {
      previousText = "";
    },
  };
}

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ isKeyboardVisible, onFocus, onInput, onTerminalKey, style }, ref) {
    const inputRef = useRef<EditingTextInputHandle>(null);
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
      inputRef.current?.replaceText("");
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
        initialValue=""
        blurOnSubmit={false}
        importantForAutofill="no"
        multiline={true}
        onChangeText={handleChangeText}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyPress={handleKeyPress}
        // The hitbox is a fixed 1x1 box, so nothing here ever needs re-measuring.
        remeasureOnChange={false}
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
