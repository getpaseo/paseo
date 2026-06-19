import type { StyleProp, TextStyle } from "react-native";
import { useEffect, useMemo, useRef } from "react";
import { TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";

interface SettingsTextAreaProps {
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  testID?: string;
  style?: StyleProp<TextStyle>;
}

export function SettingsTextArea({
  accessibilityLabel,
  value,
  onChangeText,
  placeholder,
  testID,
  style,
}: SettingsTextAreaProps) {
  const { theme } = useUnistyles();
  const inputStyle = useMemo(() => [styles.input, style], [style]);
  const inputRef = useRef<TextInput>(null);

  // RN-Web's onChange misses native input events when the textarea is portaled
  // outside the React root container (AdaptiveModalSheet's overlay root), so
  // Electron's menu-driven Cmd+V paste updates the DOM but never fires
  // onChangeText. A direct DOM listener keeps the value in sync. See #1602.
  useEffect(() => {
    if (!isWeb) return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    let composing = false;
    // Don't push the in-progress value mid-IME-composition; sync on end instead.
    const handleInput = () => {
      if (!composing) onChangeText(node.value);
    };
    const handleCompositionStart = () => {
      composing = true;
    };
    const handleCompositionEnd = () => {
      composing = false;
      onChangeText(node.value);
    };
    node.addEventListener("input", handleInput);
    node.addEventListener("compositionstart", handleCompositionStart);
    node.addEventListener("compositionend", handleCompositionEnd);
    return () => {
      node.removeEventListener("input", handleInput);
      node.removeEventListener("compositionstart", handleCompositionStart);
      node.removeEventListener("compositionend", handleCompositionEnd);
    };
  }, [onChangeText]);

  return (
    <TextInput
      ref={inputRef}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      multiline
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      style={inputStyle}
    />
  );
}

export function SettingsTextAreaCard(props: SettingsTextAreaProps) {
  return (
    <View style={settingsStyles.card}>
      <SettingsTextArea {...props} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    minHeight: 96,
    textAlignVertical: "top",
  },
}));
