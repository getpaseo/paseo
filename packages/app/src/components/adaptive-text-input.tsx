import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ForwardedRef,
  type Ref,
} from "react";
import { TextInput, type TextInputProps } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { createControlGeometry } from "@/components/ui/control-geometry";

export type AdaptiveTextInputProps = Omit<TextInputProps, "value" | "defaultValue"> & {
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

const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export const AdaptiveTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(
  function AdaptiveTextInputInner(props, ref) {
    const isMobile = useIsCompactFormFactor();
    const { initialValue, resetKey, style, onChangeText, ...inputProps } = props;
    const inputRef = useRef<TextInput | null>(null);
    const initialTextRef = useRef(initialValue);
    const replacementTextRef = useRef(initialValue ?? "");
    const previousResetKeyRef = useRef(resetKey);
    replacementTextRef.current = initialValue ?? "";
    const setInputRef = useCallback(
      (node: TextInput | null) => {
        inputRef.current = node;
        assignRef(ref, node);
      },
      [ref],
    );

    useEffect(() => {
      if (resetKey === previousResetKeyRef.current) return;
      previousResetKeyRef.current = resetKey;
      inputRef.current?.setNativeProps({ text: replacementTextRef.current });
    }, [resetKey]);

    const textInputProps = {
      ...inputProps,
      defaultValue: initialTextRef.current,
      onChangeText,
      style: [styles.outline, style, styles.text],
    };

    if (isMobile && isNative) {
      return (
        <ThemedBottomSheetTextInput
          ref={setInputRef as unknown as Ref<never>}
          {...textInputProps}
        />
      );
    }
    return <ThemedTextInput ref={setInputRef} {...textInputProps} />;
  },
);

function assignRef(ref: ForwardedRef<TextInput>, node: TextInput | null): void {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}
