import React, { forwardRef, useCallback, useEffect, useRef } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createControlGeometry } from "@/components/ui/control-geometry";
import {
  EditingTextInput,
  type EditingTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";

export type AdaptiveTextInputProps = EditingTextInputProps & {
  initialValue?: string;
  resetKey?: string | number;
};

const styles = StyleSheet.create((theme) => ({
  outline: {
    ...createControlGeometry(theme).controlFocusRingColor,
  },
  text: {
    color: theme.colors.foreground,
  },
}));

const ThemedTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export const AdaptiveTextInput = forwardRef<EditingTextInputHandle, AdaptiveTextInputProps>(
  function AdaptiveTextInputInner(props, ref) {
    const { initialValue, resetKey, style, onChangeText, ...inputProps } = props;
    const inputRef = useRef<EditingTextInputHandle | null>(null);
    const replacementTextRef = useRef(initialValue ?? "");
    const previousResetKeyRef = useRef(resetKey);
    replacementTextRef.current = initialValue ?? "";
    const setInputRef = useCallback(
      (handle: EditingTextInputHandle | null) => {
        inputRef.current = handle;
        if (typeof ref === "function") ref(handle);
        else if (ref) ref.current = handle;
      },
      [ref],
    );

    useEffect(() => {
      if (resetKey === previousResetKeyRef.current) return;
      previousResetKeyRef.current = resetKey;
      inputRef.current?.replaceText(replacementTextRef.current);
    }, [resetKey]);

    return (
      <ThemedTextInput
        {...inputProps}
        ref={setInputRef}
        initialValue={initialValue}
        onChangeText={onChangeText}
        style={[styles.outline, style, styles.text]}
      />
    );
  },
);
