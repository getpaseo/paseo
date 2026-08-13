import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import PasteInput, {
  type PastedFile,
  type PasteTextInputInstance,
} from "@mattermost/react-native-paste-input";
import { withUnistyles } from "react-native-unistyles";
import type { ComposerTextInputHandle, ComposerTextInputProps } from "./text-input-types";

type NativeInputInstance = PasteTextInputInstance & {
  blur: () => void;
  focus: () => void;
  setNativeProps: (props: { text: string }) => void;
};

const ThemedPasteInput = withUnistyles(PasteInput, (theme) => ({
  placeholderTextColor: theme.colors.surface4,
}));

export const ComposerTextInput = forwardRef<ComposerTextInputHandle, ComposerTextInputProps>(
  function ComposerTextInputNative(
    { text, onChangeText, onPasteImages, onPasteError, ...props },
    ref,
  ) {
    const inputRef = useRef<NativeInputInstance | null>(null);
    const textRef = useRef(text);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      getText: () => textRef.current,
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        inputRef.current?.setNativeProps({ text: nextText });
        if (selection) {
          inputRef.current?.setSelection(selection.start, selection.end);
        }
      },
      getNativeRef: () => inputRef.current?.getNativeRef?.() ?? inputRef.current,
    }));

    const handleChangeText = useCallback(
      (nextText: string) => {
        textRef.current = nextText;
        onChangeText(nextText);
      },
      [onChangeText],
    );

    const handlePaste = useCallback(
      (error: string | null | undefined, files: PastedFile[]) => {
        if (error) {
          onPasteError?.(error);
          return;
        }
        if (files.length > 0) {
          onPasteImages?.(files);
        }
      },
      [onPasteError, onPasteImages],
    );

    return (
      <ThemedPasteInput
        {...props}
        ref={inputRef}
        defaultValue={text}
        onChangeText={handleChangeText}
        onPaste={handlePaste}
      />
    );
  },
);
