import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { TextInput } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { ComposerTextInputHandle, ComposerTextInputProps } from "./text-input-types";

type WebTextInputElement = TextInput & {
  value?: string;
  setSelectionRange?: (start: number, end: number) => void;
};

const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.surface4,
}));

export const ComposerTextInput = forwardRef<ComposerTextInputHandle, ComposerTextInputProps>(
  function ComposerTextInputWeb(
    { text, onChangeText, onPasteImages: _, onPasteError: __, ...props },
    ref,
  ) {
    const inputRef = useRef<TextInput | null>(null);
    const textRef = useRef(text);
    textRef.current = text;
    const handleChangeText = useCallback(
      (nextText: string) => {
        textRef.current = nextText;
        onChangeText(nextText);
      },
      [onChangeText],
    );

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      getText: () => textRef.current,
      replaceText: (nextText, selection) => {
        textRef.current = nextText;
        const input = inputRef.current as WebTextInputElement | null;
        if (input && "value" in input) {
          input.value = nextText;
        }
        if (selection && typeof input?.setSelectionRange === "function") {
          input.setSelectionRange(selection.start, selection.end);
        }
      },
      getNativeRef: () => inputRef.current,
    }));

    return (
      <ThemedTextInput {...props} ref={inputRef} value={text} onChangeText={handleChangeText} />
    );
  },
);
