import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { TextInput } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import PasteInput, {
  type PastedFile,
  type PasteTextInputInstance,
} from "@mattermost/react-native-paste-input";
import { useIsInsideBottomSheet } from "./bottom-sheet-scope";
import type { EditingTextInputHandle, EditingTextInputProps } from "./types";

type NativeInput = (TextInput | PasteTextInputInstance) & {
  blur(): void;
  focus(): void;
  isFocused?(): boolean;
  clear?(): void;
  replaceText?(text: string, selection?: { start: number; end: number }): void;
  setNativeProps?(props: { text?: string; selection?: { start: number; end: number } }): void;
  setSelection?(start: number, end: number): void;
  getNativeRef?(): unknown;
};

export const EditingTextInput = forwardRef<EditingTextInputHandle, EditingTextInputProps>(
  function EditingTextInputNative(allProps, ref) {
    const isInsideBottomSheet = useIsInsideBottomSheet();
    const {
      initialValue = "",
      onChangeText,
      onPasteImages,
      onPasteError,
      variant = isInsideBottomSheet ? "bottom-sheet" : "default",
      value: _,
      defaultValue: __,
      ...props
    } = allProps as EditingTextInputProps & { value?: unknown; defaultValue?: unknown };
    const inputRef = useRef<NativeInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const textRef = useRef(initialTextRef.current);
    // Clearing swaps the native input for a fresh instance (see replaceText).
    // Until React commits that swap, `inputRef` still points at the doomed
    // instance: focusing it asks Android for the keyboard and then tears the
    // focused view down, which cancels the show. Fabric also runs view
    // commands before mount items, so a focus command sent alongside the swap
    // reaches a view that is not attached yet and the IME ignores it. Focus is
    // therefore carried by the replacement's `autoFocus`, which native applies
    // once the view is attached.
    const isAwaitingReplacementRef = useRef(false);
    const [replacement, setReplacement] = useState({ revision: 0, autoFocus: false });

    const assignInputRef = useCallback((input: NativeInput | null) => {
      inputRef.current = input;
      if (input) isAwaitingReplacementRef.current = false;
    }, []);

    const setReplacementFocus = useCallback((autoFocus: boolean) => {
      setReplacement((current) => ({ ...current, autoFocus }));
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => {
        if (isAwaitingReplacementRef.current) {
          setReplacementFocus(true);
          return;
        }
        inputRef.current?.focus();
      },
      blur: () => {
        if (isAwaitingReplacementRef.current) {
          setReplacementFocus(false);
          return;
        }
        inputRef.current?.blur();
      },
      isFocused: () => inputRef.current?.isFocused?.() ?? false,
      getText: () => textRef.current,
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        if (nextText === "") {
          const autoFocus = inputRef.current?.isFocused?.() ?? false;
          if (inputRef.current?.replaceText) {
            inputRef.current.replaceText(nextText, selection);
          } else {
            inputRef.current?.clear?.();
          }
          isAwaitingReplacementRef.current = true;
          setReplacement((current) => ({ revision: current.revision + 1, autoFocus }));
          return;
        }
        if (inputRef.current?.replaceText) {
          inputRef.current.replaceText(nextText, selection);
          return;
        }
        inputRef.current?.setNativeProps?.({
          text: nextText,
          ...(selection ? { selection } : {}),
        });
        if (selection) inputRef.current?.setSelection?.(selection.start, selection.end);
      },
      getNativeRef: () => inputRef.current?.getNativeRef?.() ?? inputRef.current,
    }));

    const handleChangeText = useCallback(
      (nextText: string) => {
        textRef.current = nextText;
        onChangeText?.(nextText);
      },
      [onChangeText],
    );
    const handlePaste = useCallback(
      (error: string | null | undefined, files: PastedFile[]) => {
        if (error) {
          onPasteError?.(error);
        } else if (files.length > 0) {
          onPasteImages?.(files);
        }
      },
      [onPasteError, onPasteImages],
    );

    const autoFocus = replacement.revision === 0 ? props.autoFocus : replacement.autoFocus;

    if (onPasteImages || onPasteError) {
      return (
        <PasteInput
          {...props}
          autoFocus={autoFocus}
          key={replacement.revision}
          ref={assignInputRef as React.Ref<PasteTextInputInstance>}
          defaultValue={textRef.current}
          onChangeText={handleChangeText}
          onPaste={handlePaste}
        />
      );
    }
    if (variant === "bottom-sheet") {
      return (
        <BottomSheetTextInput
          {...props}
          autoFocus={autoFocus}
          key={replacement.revision}
          ref={assignInputRef as unknown as React.Ref<never>}
          defaultValue={textRef.current}
          onChangeText={handleChangeText}
        />
      );
    }
    return (
      <TextInput
        {...props}
        autoFocus={autoFocus}
        key={replacement.revision}
        ref={assignInputRef as React.Ref<TextInput>}
        defaultValue={textRef.current}
        onChangeText={handleChangeText}
      />
    );
  },
);
