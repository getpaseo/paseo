import React, { forwardRef, useCallback, useEffect, useRef, type ForwardedRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createControlGeometry } from "@/components/ui/control-geometry";

export type AdaptiveTextInputProps = Omit<TextInputProps, "value" | "defaultValue"> & {
  initialValue?: string;
  resetKey?: string | number;
};

interface WebTextInputElement extends TextInput {
  value?: string;
  addEventListener: (type: "compositionstart" | "compositionend", listener: EventListener) => void;
  removeEventListener: (
    type: "compositionstart" | "compositionend",
    listener: EventListener,
  ) => void;
}

const styles = StyleSheet.create((theme) => ({
  outline: {
    ...createControlGeometry(theme).controlFocusRingColor,
  },
  text: {
    color: theme.colors.foreground,
  },
}));

const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

function assignRef(ref: ForwardedRef<TextInput>, node: TextInput | null): void {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

export const AdaptiveTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(
  function AdaptiveTextInputWeb({ initialValue, resetKey, style, onChangeText, ...props }, ref) {
    const inputRef = useRef<TextInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const replacementTextRef = useRef(initialValue ?? "");
    const previousResetKeyRef = useRef(resetKey);
    const textRef = useRef(initialTextRef.current ?? "");
    const isComposingRef = useRef(false);
    const onChangeTextRef = useRef(onChangeText);
    replacementTextRef.current = initialValue ?? "";
    onChangeTextRef.current = onChangeText;

    const setInputRef = useCallback(
      (node: TextInput | null) => {
        inputRef.current = node;
        assignRef(ref, node);
      },
      [ref],
    );

    useEffect(() => {
      const input = inputRef.current as WebTextInputElement | null;
      if (!input) return;

      const startComposition = () => {
        isComposingRef.current = true;
      };
      const endComposition = () => {
        isComposingRef.current = false;
        const nextText = input.value ?? "";
        if (nextText === textRef.current) return;
        textRef.current = nextText;
        onChangeTextRef.current?.(nextText);
      };

      input.addEventListener("compositionstart", startComposition);
      input.addEventListener("compositionend", endComposition);
      return () => {
        input.removeEventListener("compositionstart", startComposition);
        input.removeEventListener("compositionend", endComposition);
      };
    }, []);

    useEffect(() => {
      if (resetKey === previousResetKeyRef.current) return;
      previousResetKeyRef.current = resetKey;
      const nextText = replacementTextRef.current;
      textRef.current = nextText;
      const input = inputRef.current as WebTextInputElement | null;
      if (input && "value" in input) {
        input.value = nextText;
      }
    }, [resetKey]);

    const handleChangeText = useCallback((nextText: string) => {
      if (isComposingRef.current || nextText === textRef.current) return;
      textRef.current = nextText;
      onChangeTextRef.current?.(nextText);
    }, []);

    return (
      <ThemedTextInput
        {...props}
        ref={setInputRef}
        defaultValue={initialTextRef.current}
        onChangeText={handleChangeText}
        style={[styles.outline, style, styles.text]}
      />
    );
  },
);
