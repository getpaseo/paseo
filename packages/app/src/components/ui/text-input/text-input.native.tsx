import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useReducer,
  useState,
} from "react";
import { TextInput } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import PasteInput, {
  type PastedFile,
  type PasteTextInputInstance,
} from "@mattermost/react-native-paste-input";
import { useIsInsideBottomSheet } from "@/components/ui/bottom-sheet-scope";
import type { EditingTextInputHandle, EditingTextInputProps } from "./types";
import { useUserInputFocus } from "./user-focus";

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
    const userFocus = useUserInputFocus(allProps);
    const isInsideBottomSheet = useIsInsideBottomSheet();
    const {
      initialValue = "",
      onChangeText,
      onUserFocus: ___,
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
    const isAwaitingReplacementRef = useRef(false);
    const [replacement, setReplacement] = useState({ revision: 0, autoFocus: false });
    const [, bumpTextRevision] = useReducer((revision: number) => revision + 1, 0);

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
          userFocus.beforeProgrammaticFocus();
          setReplacementFocus(true);
          return;
        }
        if (!inputRef.current?.isFocused?.()) userFocus.beforeProgrammaticFocus();
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
        if (inputRef.current?.replaceText) {
          inputRef.current.replaceText(nextText, selection);
          return;
        }
        if (nextText === "") {
          inputRef.current?.clear?.();
          return;
        }
        inputRef.current?.setNativeProps?.({
          text: nextText,
          ...(selection ? { selection } : {}),
        });
        if (selection) inputRef.current?.setSelection?.(selection.start, selection.end);
      },
      reset: () => {
        textRef.current = "";
        const autoFocus = inputRef.current?.isFocused?.() ?? false;
        if (autoFocus) userFocus.beforeProgrammaticFocus();
        if (inputRef.current?.replaceText) {
          inputRef.current.replaceText("");
        } else {
          inputRef.current?.clear?.();
        }
        isAwaitingReplacementRef.current = true;
        setReplacement((current) => ({ revision: current.revision + 1, autoFocus }));
      },
      getNativeRef: () => inputRef.current?.getNativeRef?.() ?? inputRef.current,
    }));

    const handleChangeText = useCallback(
      (nextText: string) => {
        textRef.current = nextText;
        onChangeText?.(nextText);
        bumpTextRevision();
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
          onFocus={userFocus.onFocus}
          onTouchStart={userFocus.onTouchStart}
          onPressIn={userFocus.onPressIn}
          onBlur={userFocus.onBlur}
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
          onFocus={userFocus.onFocus}
          onTouchStart={userFocus.onTouchStart}
          onPressIn={userFocus.onPressIn}
          onBlur={userFocus.onBlur}
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
        onFocus={userFocus.onFocus}
        onTouchStart={userFocus.onTouchStart}
        onPressIn={userFocus.onPressIn}
        onBlur={userFocus.onBlur}
      />
    );
  },
);
