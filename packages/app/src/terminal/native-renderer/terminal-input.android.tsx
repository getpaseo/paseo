import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import {
  hasActiveOverlay,
  registerFocusedTextInput,
  subscribeHardwareKeyboard,
  useKeyboardFocusSurface,
} from "@/keyboard";
import {
  PaseoTerminalInputView,
  type PaseoTerminalInputKeyEvent,
  type PaseoTerminalInputViewHandle,
} from "../../../modules/paseo-terminal/terminal-input-view";
import {
  resolveTerminalInputFocusRequest,
  TERMINAL_INPUT_HITBOX_SIZE,
  TERMINAL_INPUT_NATIVE_ID,
  type TerminalInputHandle,
  type TerminalInputProps,
} from "./terminal-input.types";
import { resolveHardwareTerminalKey, resolveNativeTerminalKey } from "./terminal-key-events";

export {
  resolveTerminalInputFocusRequest,
  TERMINAL_INPUT_HITBOX_SIZE,
  TERMINAL_INPUT_NATIVE_ID,
  type TerminalInputFocusRequest,
  type TerminalInputHandle,
  type TerminalInputProps,
} from "./terminal-input.types";

export const TerminalInput = forwardRef<TerminalInputHandle, TerminalInputProps>(
  function TerminalInput({ isKeyboardVisible, onFocus, onInput, onTerminalKey, style }, ref) {
    const nativeRef = useRef<PaseoTerminalInputViewHandle>(null);
    const isFocusedRef = useRef(false);
    const releaseFocusedInputRef = useRef<(() => void) | null>(null);
    const [isFocused, setIsFocused] = useState(false);
    const onTerminalKeyRef = useRef(onTerminalKey);
    onTerminalKeyRef.current = onTerminalKey;
    const inputStyle = useMemo(() => [styles.input, style], [style]);

    useKeyboardFocusSurface("terminal", isFocused);

    const releaseFocusedTextInput = useCallback(() => {
      releaseFocusedInputRef.current?.();
      releaseFocusedInputRef.current = null;
    }, []);

    useEffect(() => releaseFocusedTextInput, [releaseFocusedTextInput]);

    const showNativeKeyboard = useCallback(() => {
      const input = nativeRef.current;
      if (!input) {
        return;
      }
      const focusRequest = resolveTerminalInputFocusRequest({
        isInputFocused: isFocusedRef.current,
        isKeyboardVisible,
      });
      if (focusRequest === "none") {
        return;
      }
      void input.showKeyboard();
    }, [isKeyboardVisible]);

    const blurNativeInput = useCallback(() => {
      isFocusedRef.current = false;
      setIsFocused(false);
      releaseFocusedTextInput();
      void nativeRef.current?.blurInput();
    }, [releaseFocusedTextInput]);

    useEffect(() => {
      // Physical arrows arrive through the hardware keyboard module, which claims
      // them at the window level so Android DPAD focus search cannot steal focus.
      return subscribeHardwareKeyboard((event) => {
        if (!isFocusedRef.current || event.phase !== "down" || event.isComposing) return;
        if (hasActiveOverlay()) return;
        const key = resolveHardwareTerminalKey(event);
        if (!key) return;
        onTerminalKeyRef.current?.({
          key,
          ctrl: event.ctrlKey,
          shift: event.shiftKey,
          alt: event.altKey,
          meta: event.metaKey,
        });
      });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          showNativeKeyboard();
        },
        showKeyboard: () => {
          showNativeKeyboard();
        },
        blur: () => {
          blurNativeInput();
        },
      }),
      [blurNativeInput, showNativeKeyboard],
    );

    const handleFocusChange = useCallback(
      (focused: boolean) => {
        isFocusedRef.current = focused;
        setIsFocused(focused);
        if (focused) {
          if (!releaseFocusedInputRef.current) {
            releaseFocusedInputRef.current = registerFocusedTextInput();
          }
          onFocus?.();
        } else {
          releaseFocusedTextInput();
        }
      },
      [onFocus, releaseFocusedTextInput],
    );

    const handleTerminalInput = useCallback(
      (data: string) => {
        if (data.length > 0) {
          onInput?.(data);
        }
      },
      [onInput],
    );

    const handleNativeTerminalKey = useCallback(
      (event: PaseoTerminalInputKeyEvent) => {
        const key = resolveNativeTerminalKey(event.key);
        if (!key) return;
        onTerminalKey?.({
          key,
          ctrl: event.ctrl,
          shift: event.shift,
          alt: event.alt,
          meta: event.meta,
        });
      },
      [onTerminalKey],
    );

    return (
      <PaseoTerminalInputView
        ref={nativeRef}
        accessibilityLabel="Terminal input"
        accessible={true}
        nativeID={TERMINAL_INPUT_NATIVE_ID}
        onFocusChange={handleFocusChange}
        onTerminalInput={handleTerminalInput}
        onTerminalKey={handleNativeTerminalKey}
        style={inputStyle}
        testID="terminal-native-input"
      />
    );
  },
);

const styles = StyleSheet.create({
  input: {
    backgroundColor: "transparent",
    height: TERMINAL_INPUT_HITBOX_SIZE,
    left: 0,
    opacity: 0.01,
    padding: 0,
    position: "absolute",
    top: 0,
    width: TERMINAL_INPUT_HITBOX_SIZE,
  },
});
