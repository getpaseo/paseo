import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { TextInput } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import type { ComposerTextInputHandle, ComposerTextInputProps } from "./text-input-types";

interface WebTextInputElement extends TextInput {
  value?: string;
  setSelectionRange?: (start: number, end: number) => void;
  addEventListener: (type: "compositionstart" | "compositionend", listener: EventListener) => void;
  removeEventListener: (
    type: "compositionstart" | "compositionend",
    listener: EventListener,
  ) => void;
}

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
    const onChangeTextRef = useRef(onChangeText);
    const [isComposing, setIsComposing] = useState(false);
    if (!isComposing) textRef.current = text;
    onChangeTextRef.current = onChangeText;

    useEffect(() => {
      const input = inputRef.current as WebTextInputElement | null;
      if (!input) return;

      let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
      const startComposition = () => {
        if (compositionEndTimer !== null) {
          clearTimeout(compositionEndTimer);
          compositionEndTimer = null;
        }
        setIsComposing(true);
      };
      const endComposition = () => {
        const nextText = input.value ?? "";
        if (nextText !== textRef.current) {
          textRef.current = nextText;
          onChangeTextRef.current(nextText);
        }
        compositionEndTimer = setTimeout(() => {
          compositionEndTimer = null;
          setIsComposing(false);
        }, 0);
      };

      input.addEventListener("compositionstart", startComposition);
      input.addEventListener("compositionend", endComposition);
      return () => {
        if (compositionEndTimer !== null) clearTimeout(compositionEndTimer);
        input.removeEventListener("compositionstart", startComposition);
        input.removeEventListener("compositionend", endComposition);
      };
    }, []);

    const handleChangeText = useCallback(
      (nextText: string) => {
        if (nextText === textRef.current) return;
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
      <ThemedTextInput
        {...props}
        ref={inputRef}
        value={isComposing ? undefined : text}
        onChangeText={handleChangeText}
      />
    );
  },
);
