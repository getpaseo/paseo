import { useCallback, useEffect, useRef, useState } from "react";
import {
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  EditingTextInput,
  type EditingTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import { toErrorMessage } from "@/utils/error-messages";

type KeyPressEvent = Parameters<NonNullable<EditingTextInputProps["onKeyPress"]>>[0];

const DOUBLE_CLICK_DELAY_MS = 300;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface InlineRenameInputProps {
  initialValue: string;
  onSubmit: (value: string) => Promise<void> | void;
  onCancel: () => void;
  placeholder?: string;
  maxLength?: number;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export function useDoubleClick(onDoubleClick: () => void) {
  const lastPointerUpAtRef = useRef(0);

  return useCallback(
    (event?: { button?: number; nativeEvent?: { button?: number } }) => {
      const button = event?.nativeEvent?.button ?? event?.button;
      if (button !== undefined && button !== 0) {
        return;
      }
      const now = Date.now();
      if (now - lastPointerUpAtRef.current <= DOUBLE_CLICK_DELAY_MS) {
        lastPointerUpAtRef.current = 0;
        onDoubleClick();
        return;
      }
      lastPointerUpAtRef.current = now;
    },
    [onDoubleClick],
  );
}

export function InlineRenameInput({
  initialValue,
  onSubmit,
  onCancel,
  placeholder,
  maxLength,
  style,
  inputStyle,
  testID,
  accessibilityLabel,
}: InlineRenameInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle>(null);
  const draftRef = useRef(initialValue);
  const phaseRef = useRef<"editing" | "submitting" | "cancelled">("editing");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      const text = input.getText();
      input.replaceText(text, { start: 0, end: text.length });
    }, 50);
    return () => clearTimeout(timeout);
  }, []);

  const handleChangeText = useCallback((value: string) => {
    draftRef.current = value;
    setError(null);
  }, []);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    phaseRef.current = "cancelled";
    onCancel();
  }, [isPending, onCancel]);

  const handleSubmit = useCallback(async () => {
    if (isPending || phaseRef.current !== "editing") return;

    const value = draftRef.current.trim();
    if (!value) {
      setError(t("common.errors.nameRequired"));
      return;
    }
    if (value === initialValue.trim()) {
      handleCancel();
      return;
    }

    phaseRef.current = "submitting";
    setIsPending(true);
    try {
      await onSubmit(value);
      onCancel();
    } catch (submitError) {
      phaseRef.current = "editing";
      setIsPending(false);
      setError(toErrorMessage(submitError) || t("common.errors.unableToSave"));
    }
  }, [handleCancel, initialValue, isPending, onCancel, onSubmit, t]);

  const handleKeyPress = useCallback(
    (event: KeyPressEvent) => {
      if (event.nativeEvent.key !== "Escape") return;
      event.preventDefault();
      handleCancel();
    },
    [handleCancel],
  );

  const stopPropagation = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handleSubmitEditing = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleBlur = useCallback(() => {
    const value = draftRef.current.trim();
    if (!value || value === initialValue.trim()) {
      handleCancel();
      return;
    }
    void handleSubmit();
  }, [handleCancel, handleSubmit, initialValue]);

  const errorTestID = testID ? `${testID}-error` : undefined;

  return (
    <View style={[styles.container, style]}>
      <EditingTextInput
        ref={inputRef}
        accessibilityLabel={accessibilityLabel}
        initialValue={initialValue}
        onChangeText={handleChangeText}
        onKeyPress={handleKeyPress}
        onSubmitEditing={handleSubmitEditing}
        onBlur={handleBlur}
        onPressIn={stopPropagation}
        placeholder={placeholder}
        maxLength={maxLength}
        editable={!isPending}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        style={[styles.input, inputStyle, error ? styles.inputError : null]}
        testID={testID}
      />
      {isPending ? (
        <View style={styles.pending} pointerEvents="none">
          <ThemedLoadingSpinner size={14} uniProps={mutedColorMapping} />
        </View>
      ) : null}
      {error ? (
        <Text style={styles.error} testID={errorTestID} pointerEvents="none">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
    flex: 1,
    minWidth: 0,
  },
  input: {
    minWidth: 0,
    width: "100%",
    height: 28,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  inputError: {
    borderColor: theme.colors.palette.red[300],
  },
  pending: {
    position: "absolute",
    top: 0,
    right: theme.spacing[1],
    bottom: 0,
    justifyContent: "center",
    paddingLeft: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  error: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 20,
    marginTop: 2,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.palette.red[300],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    color: theme.colors.palette.red[300],
    backgroundColor: theme.colors.surface2,
    fontSize: theme.fontSize.sm,
  },
}));
