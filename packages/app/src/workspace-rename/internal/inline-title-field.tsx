import { useCallback, useEffect, useRef } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";

const ThemedTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export interface InlineTitleFieldProps {
  initialValue: string;
  placeholder: string;
  /** Holds the submitted text on screen while the daemon accepts it. */
  readOnly: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
  testID: string;
}

/**
 * A single-line input that stands in for the row's title text. It reports exactly one outcome:
 * Enter and blur commit, Escape cancels. Enter blurs the input too, so without the settled latch
 * one Enter would commit twice.
 *
 * Its box is the slot it is rendered in (100% of the title line), and the outline that marks it
 * as editable paints outside that box, so swapping it in for the title never moves the row.
 */
export function InlineTitleField({
  initialValue,
  placeholder,
  readOnly,
  onCommit,
  onCancel,
  testID,
}: InlineTitleFieldProps) {
  const inputRef = useRef<EditingTextInputHandle>(null);
  const settledRef = useRef(false);
  const focusedRef = useRef(false);

  // Rename starts from a menu item. The menu restores focus to its trigger as it closes, so
  // focusing in the same commit would lose to it and the blur would commit an unchanged title.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelection({ start: 0, end: initialValue.length });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialValue]);

  const settle = useCallback((outcome: () => void) => {
    if (settledRef.current) return;
    settledRef.current = true;
    outcome();
  }, []);

  const commit = useCallback(() => {
    settle(() => onCommit(inputRef.current?.getText() ?? initialValue));
  }, [initialValue, onCommit, settle]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const handleBlur = useCallback(() => {
    // A blur before the first focus is the menu handing focus back, not the user leaving.
    if (!focusedRef.current) return;
    commit();
  }, [commit]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key !== "Escape") return;
      settle(onCancel);
    },
    [onCancel, settle],
  );

  return (
    <ThemedTextInput
      ref={inputRef}
      initialValue={initialValue}
      placeholder={placeholder}
      editable={!readOnly}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      selectTextOnFocus={false}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onSubmitEditing={commit}
      onKeyPress={handleKeyPress}
      style={styles.input}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Typography matches the sidebar title it replaces; the box comes from the slot.
  input: {
    width: "100%",
    height: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    includeFontPadding: false,
    borderRadius: theme.borderRadius.sm,
    outlineStyle: "solid",
    outlineWidth: 1,
    outlineOffset: 2,
    outlineColor: theme.colors.accent,
  },
}));
