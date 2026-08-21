import React, { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { TextInput } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import PasteInput, {
  type PastedFile,
  type PasteTextInputInstance,
} from "@mattermost/react-native-paste-input";
import type { EditingTextInputHandle, EditingTextInputProps } from "./types";

type NativeInput = (TextInput | PasteTextInputInstance) & {
  blur(): void;
  focus(): void;
  isFocused(): boolean;
  clear?(): void;
  replaceText?(text: string, selection?: { start: number; end: number }): void;
  setNativeProps?(props: { text?: string; selection?: { start: number; end: number } }): void;
  setSelection?(start: number, end: number): void;
  getNativeRef?(): unknown;
};

export const EditingTextInput = forwardRef<EditingTextInputHandle, EditingTextInputProps>(
  function EditingTextInputNative(allProps, ref) {
    const {
      initialValue = "",
      onChangeText,
      onPasteImages,
      onPasteError,
      variant = "default",
      value: _,
      defaultValue: __,
      ...props
    } = allProps as EditingTextInputProps & { value?: unknown; defaultValue?: unknown };
    const inputRef = useRef<NativeInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const textRef = useRef(initialTextRef.current);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      isFocused: () => inputRef.current?.isFocused() ?? false,
      getText: () => textRef.current,
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        if (inputRef.current?.replaceText) {
          inputRef.current.replaceText(nextText, selection);
          return;
        }
        if (nextText === "") {
          inputRef.current?.clear?.();
        } else {
          inputRef.current?.setNativeProps?.({
            text: nextText,
            ...(selection ? { selection } : {}),
          });
        }
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
          ref={inputRef as React.Ref<PasteTextInputInstance>}
          defaultValue={initialTextRef.current}
          onChangeText={handleChangeText}
          onPaste={handlePaste}
        />
      );
    }
    if (variant === "bottom-sheet") {
      return (
        <BottomSheetTextInput
          {...props}
          ref={inputRef as unknown as React.Ref<never>}
          defaultValue={initialTextRef.current}
          onChangeText={handleChangeText}
        />
      );
    }
    return (
      <TextInput
        {...props}
        ref={inputRef as React.Ref<TextInput>}
        defaultValue={initialTextRef.current}
        onChangeText={handleChangeText}
      />
    );
  },
);
