import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";

export interface GoalFeedbackCopy {
  title: string;
  label: string;
  placeholder: string;
  send: string;
}

/**
 * Feedback sent back to an agent: changes to a held change set, or a plan for the Lead to redo.
 * Mount only while open, so every open starts empty.
 */
export function GoalFeedbackSheet({
  copy,
  subject,
  isRequired,
  isSending,
  error,
  onSend,
  onClose,
  testID,
}: {
  copy: GoalFeedbackCopy;
  /** What the feedback is about, under the title. */
  subject: string;
  /** Change requests need text; plan feedback is optional. */
  isRequired: boolean;
  isSending: boolean;
  error: string | null;
  onSend: (feedback: string) => void;
  onClose: () => void;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [findings, setFindings] = useState("");
  const canSend = (!isRequired || findings.trim().length > 0) && !isSending;
  const handleSend = useCallback(() => onSend(findings.trim()), [findings, onSend]);
  const header = useMemo<SheetHeader>(
    // The header renders the subtitle as is, so it must be an element, not a bare string.
    () => ({
      title: copy.title,
      subtitle: (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subject}
        </Text>
      ),
    }),
    [copy.title, subject],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSend}
          disabled={!canSend}
          loading={isSending}
          testID={`${testID}-send`}
        >
          {copy.send}
        </Button>
      </View>
    ),
    [canSend, copy.send, handleSend, isSending, onClose, t, testID],
  );

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} footer={footer} testID={testID}>
      <Field label={copy.label}>
        <FormTextInput
          size={size}
          testID={`${testID}-input`}
          accessibilityLabel={copy.label}
          initialValue=""
          onChangeText={setFindings}
          placeholder={copy.placeholder}
          style={styles.input}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
        />
      </Field>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  input: {
    minHeight: 120,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
