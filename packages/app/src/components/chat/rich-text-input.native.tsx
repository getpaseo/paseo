/**
 * Native fallback for the Lexical rich-text input. Mobile keeps the plain
 * TextInput (markdown cru) because Lexical is web-only. We expose the same
 * API surface so the outer Composer doesn't need to branch.
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import { TextInput, type TextInputProps } from "react-native";

export interface RichTextInputHandle {
  focus: () => void;
  insertMention: (userId: string, _name: string) => void;
}

interface RichTextInputProps {
  value: string;
  placeholder?: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  minHeight?: number;
  maxHeight?: number;
  style?: TextInputProps["style"];
  placeholderTextColor?: string;
}

export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    {
      value,
      placeholder,
      onChangeText,
      onSubmit,
      disabled,
      minHeight = 38,
      maxHeight = 140,
      style,
      placeholderTextColor,
    },
    ref,
  ) {
    const inputRef = useRef<TextInput>(null);

    useImperativeHandle(ref, () => ({
      focus() {
        inputRef.current?.focus();
      },
      insertMention(userId: string, _name: string) {
        // Native: just append the raw token. The markdown renderer on the
        // receiver side expands it into a proper mention chip.
        onChangeText(`${value}<@${userId}> `);
      },
    }));

    return (
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        editable={!disabled}
        multiline
        onSubmitEditing={onSubmit}
        blurOnSubmit={false}
        style={[{ minHeight, maxHeight }, style]}
      />
    );
  },
);
