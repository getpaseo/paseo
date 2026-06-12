import { forwardRef, useMemo, type ReactNode } from "react";
import { Text, View, type TextInput } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";

interface FormFieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
  testID?: string;
}

export function FormField({ label, children, hint, error, testID }: FormFieldProps) {
  const hintTestID = useMemo(() => (testID ? `${testID}-hint` : undefined), [testID]);
  const errorTestID = useMemo(() => (testID ? `${testID}-error` : undefined), [testID]);
  const hintOrError = useMemo(() => {
    if (error) {
      return (
        <Text style={styles.errorText} testID={errorTestID}>
          {error}
        </Text>
      );
    }
    if (hint) {
      return (
        <Text style={styles.hintText} testID={hintTestID}>
          {hint}
        </Text>
      );
    }
    return null;
  }, [error, hint, errorTestID, hintTestID]);

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hintOrError}
    </View>
  );
}

export const FormTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(function FormTextInput(
  { style, ...props },
  ref,
) {
  const inputStyle = useMemo(() => [formInputStyles.input, style], [style]);
  return <AdaptiveTextInput ref={ref} {...props} style={inputStyle} />;
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));

const formInputStyles = StyleSheet.create((theme) => ({
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
}));
