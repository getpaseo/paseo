import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPlanReviewAction } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import type { PendingPermission } from "@/types/shared";

const PlanFeedbackInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export function PlanReviewForm({
  permission,
  client,
  isAwaitingReview,
  isCompact,
  draft,
  onChangeDraft,
  onClose,
  onSubmitSuccess,
}: {
  permission: PendingPermission;
  client: DaemonClient | null;
  isAwaitingReview: boolean;
  isCompact: boolean;
  draft: string;
  onChangeDraft: (text: string) => void;
  onClose: () => void;
  onSubmitSuccess: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [submittingAction, setSubmittingAction] = useState<AgentPlanReviewAction | null>(null);
  const submitting = useRef(false);
  const placeholder = t("agentStream.permission.feedbackPlaceholder");
  const isSubmitting = submittingAction !== null;
  const stale = !isAwaitingReview && !isSubmitting;
  const errorText = error ?? (stale ? t("agentStream.permission.stalePlan") : null);
  const submitDisabled = isSubmitting || stale || !client || !draft.trim();

  const submit = useCallback(
    async (action: AgentPlanReviewAction) => {
      if (submitting.current || !client || !isAwaitingReview || !draft.trim()) return;
      submitting.current = true;
      setSubmittingAction(action);
      setError(null);
      try {
        await client.reviewAgentPlan({
          agentId: permission.agentId,
          permissionRequestId: permission.request.id,
          action,
          text: draft,
        });
        onSubmitSuccess();
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : t("agentStream.permission.planReviewFailed"),
        );
      } finally {
        submitting.current = false;
        setSubmittingAction(null);
      }
    },
    [client, draft, isAwaitingReview, onSubmitSuccess, permission, t],
  );
  const requestChanges = useCallback(() => submit("request_changes"), [submit]);
  const implementWithNotes = useCallback(() => submit("implement_with_notes"), [submit]);
  const cancelButton = (
    <Button size="sm" variant="ghost" onPress={onClose} disabled={isSubmitting}>
      {t("common.actions.cancel")}
    </Button>
  );

  return (
    <View style={styles.form}>
      <PlanFeedbackInput
        accessibilityLabel={placeholder}
        autoFocus
        multiline
        editable={!isSubmitting}
        placeholder={placeholder}
        initialValue={draft}
        onChangeText={onChangeDraft}
        style={styles.input}
        testID="plan-review-input"
      />
      {errorText ? (
        <Text accessibilityRole="alert" style={styles.error} testID="plan-review-error">
          {errorText}
        </Text>
      ) : null}
      <View style={isCompact ? styles.compactActions : styles.actions}>
        {isCompact ? null : cancelButton}
        <Button
          size={isCompact ? "md" : "sm"}
          variant="outline"
          onPress={requestChanges}
          loading={submittingAction === "request_changes"}
          disabled={submitDisabled}
          testID="plan-review-submit-changes"
        >
          {t("agentStream.permission.requestChanges")}
        </Button>
        <Button
          size={isCompact ? "md" : "sm"}
          variant="outline"
          onPress={implementWithNotes}
          loading={submittingAction === "implement_with_notes"}
          disabled={submitDisabled}
          testID="plan-review-submit-implementation"
        >
          {t("agentStream.permission.implementWithNotes")}
        </Button>
        {isCompact ? cancelButton : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[2],
  },
  input: {
    minHeight: 88,
    maxHeight: 192,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlignVertical: "top",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  compactActions: {
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
