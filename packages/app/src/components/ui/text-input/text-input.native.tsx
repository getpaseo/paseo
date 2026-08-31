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
    const restoreFocusAfterResetRef = useRef(false);
    const [nativeInputRevision, setNativeInputRevision] = useState(0);

    const assignInputRef = useCallback((input: NativeInput | null) => {
      inputRef.current = input;
      if (!input || !restoreFocusAfterResetRef.current) return;
      restoreFocusAfterResetRef.current = false;
      input.focus();
    }, []);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => inputRef.current?.isFocused?.() ?? false,
      getText: () => textRef.current,
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        if (nextText === "") {
          restoreFocusAfterResetRef.current = inputRef.current?.isFocused?.() ?? false;
          if (inputRef.current?.replaceText) {
            inputRef.current.replaceText(nextText, selection);
          } else {
            inputRef.current?.clear?.();
          }
          setNativeInputRevision((revision) => revision + 1);
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

    if (onPasteImages || onPasteError) {
      return (
        <PasteInput
          {...props}
          key={nativeInputRevision}
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
          key={nativeInputRevision}
          ref={assignInputRef as unknown as React.Ref<never>}
          defaultValue={textRef.current}
          onChangeText={handleChangeText}
        />
      );
    }
    return (
      <TextInput
        {...props}
        key={nativeInputRevision}
        ref={assignInputRef as React.Ref<TextInput>}
        defaultValue={textRef.current}
        onChangeText={handleChangeText}
      />
    );
  },
);
