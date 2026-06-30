import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";

export interface AdaptiveRenameModalProps {
  visible: boolean;
  title: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void> | void;
  validate?: (value: string) => string | null;
  maxLength?: number;
  testID?: string;
  children?: ReactNode;
  submitDisabled?: boolean;
}

export function AdaptiveRenameModal({
  visible,
  title,
  initialValue,
  placeholder,
  submitLabel,
  onClose,
  onSubmit,
  validate,
  maxLength,
  testID,
  children,
  submitDisabled: submitDisabledProp,
}: AdaptiveRenameModalProps) {
  const { t } = useTranslation();
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
      if (isWeb && node instanceof HTMLInputElement) {
        node.setSelectionRange(0, length);
      } else if (!isWeb && length > 0) {
        node.setNativeProps({ selection: { start: 0, end: length } });
      }
    }, 50);
    return () => clearTimeout(timeout);
  }, [visible, initialValue]);

  const computeError = useCallback(
    (value: string): string | null => {
      if (!value.trim()) return t("common.errors.nameRequired");
      return validate ? validate(value) : null;
    },
    [validate, t],
  );

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      setError(computeError(value));
    },
    [computeError],
  );

  const submitDisabled =
    isPending ||
    ((submitDisabledProp ?? true) && draft === initialValue) ||
    computeError(draft) !== null;

  const handleSubmit = useCallback(async () => {
    if (isPending || submitDisabled) return;
    const value = draft;
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
      const message =
        err instanceof Error && err.message ? err.message : t("common.errors.unableToSave");
      setError(message);
    }
  }, [isPending, submitDisabled, draft, computeError, onSubmit, onClose, t]);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const handleSubmitVoid = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const inputTestID = testID ? `${testID}-input` : undefined;
  const errorTestID = testID ? `${testID}-error` : undefined;
  const submitTestID = testID ? `${testID}-submit` : undefined;
  const cancelTestID = testID ? `${testID}-cancel` : undefined;
  const sheetHeader = useMemo<SheetHeader>(() => ({ title }), [title]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={sheetHeader}
      testID={testID}
    >
      <View style={styles.body}>
        <AdaptiveTextInput
          ref={inputRef}
          initialValue={initialValue}
          onChangeText={handleChange}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          maxLength={maxLength}
          onSubmitEditing={handleSubmitVoid}
          style={styles.input}
          testID={inputTestID}
        />
        {error ? (
          <Text style={styles.errorText} testID={errorTestID}>
            {error}
          </Text>
        ) : null}
        {children ? <View style={styles.children}>{children}</View> : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={isPending}
            testID={cancelTestID}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSubmitVoid}
            disabled={submitDisabled}
            testID={submitTestID}
          >
            {isPending ? t("renameModal.saving") : (submitLabel ?? t("renameModal.rename"))}
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
  children: {
    marginTop: -theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
