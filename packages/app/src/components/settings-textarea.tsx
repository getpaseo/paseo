import type { StyleProp, TextStyle } from "react-native";
import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";

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

  return (
    <TextInput
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      multiline
      initialValue={value}
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
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    minHeight: 96,
    textAlignVertical: "top",
  },
}));
