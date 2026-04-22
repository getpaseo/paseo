import { useCallback, useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";

export interface RenameModalProps {
  visible: boolean;
  title: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void> | void;
  validate?: (value: string) => string | null;
  transform?: (value: string) => string;
  maxLength?: number;
  testID?: string;
}

export function RenameModal({
  visible,
  title,
  initialValue,
  placeholder,
  submitLabel = "Rename",
  onClose,
  onSubmit,
  validate,
  transform,
  maxLength,
  testID,
}: RenameModalProps) {
  const { theme } = useUnistyles();
  const [draft, setDraft] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(initialValue);
    setError(null);
    setIsPending(false);
  }, [visible, initialValue]);

  useEffect(() => {
    if (!visible) return;
    const length = initialValue.length;
    const timeout = setTimeout(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      if (isWeb) {
        const htmlNode: unknown = node;
        if (htmlNode instanceof HTMLInputElement) {
          htmlNode.setSelectionRange(0, length);
        }
      } else if (length > 0) {
        node.setNativeProps?.({ selection: { start: 0, end: length } });
      }
    }, 50);
    return () => clearTimeout(timeout);
  }, [visible, initialValue]);

  const computeError = useCallback(
    (value: string): string | null => {
      if (!value.trim()) return "Name is required";
      return validate ? validate(value) : null;
    },
    [validate],
  );

  const handleChange = useCallback(
    (value: string) => {
      const next = transform ? transform(value) : value;
      setDraft(next);
      setError(null);
    },
    [transform],
  );

  const handleSubmit = useCallback(async () => {
    if (isPending) return;
    const value = draft;
    if (value === initialValue) return;
    const validationError = computeError(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      setIsPending(true);
      await onSubmit(value);
      setIsPending(false);
      onClose();
    } catch (err) {
      setIsPending(false);
      const message = err instanceof Error && err.message ? err.message : "Unable to save";
      setError(message);
    }
  }, [isPending, draft, initialValue, computeError, onSubmit, onClose]);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const submitDisabled = isPending || draft === initialValue || computeError(draft) !== null;
  const inputTestID = testID ? `${testID}-input` : undefined;
  const errorTestID = testID ? `${testID}-error` : undefined;
  const submitTestID = testID ? `${testID}-submit` : undefined;
  const cancelTestID = testID ? `${testID}-cancel` : undefined;

  return (
    <AdaptiveModalSheet visible={visible} onClose={handleCancel} title={title} testID={testID}>
      <View style={styles.body}>
        <AdaptiveTextInput
          ref={inputRef}
          value={draft}
          onChangeText={handleChange}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          maxLength={maxLength}
          onSubmitEditing={() => void handleSubmit()}
          style={styles.input}
          testID={inputTestID}
        />
        {error ? (
          <Text style={styles.errorText} testID={errorTestID}>
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={{ flex: 1 }}
            onPress={handleCancel}
            disabled={isPending}
            testID={cancelTestID}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            style={{ flex: 1 }}
            onPress={() => void handleSubmit()}
            disabled={submitDisabled}
            testID={submitTestID}
          >
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
