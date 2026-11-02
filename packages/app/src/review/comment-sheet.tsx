import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import type { InlineReviewActions, InlineReviewEditorState } from "./geometry";

export function ReviewCommentSheet({
  editor,
  reviewActions,
  onChangeBody,
  enabled,
}: {
  enabled: boolean | undefined;
  editor: InlineReviewEditorState | null;
  reviewActions: InlineReviewActions;
  onChangeBody: (body: string) => void;
}) {
  if (enabled === false || !editor) return null;
  return (
    <OpenReviewCommentSheet
      editor={editor}
      reviewActions={reviewActions}
      onChangeBody={onChangeBody}
    />
  );
}

function OpenReviewCommentSheet({
  editor,
  reviewActions,
  onChangeBody,
}: {
  editor: InlineReviewEditorState;
  reviewActions: InlineReviewActions;
  onChangeBody: (body: string) => void;
}) {
  const { t } = useTranslation();
  const context = `${editor.target.filePath} · ${editor.target.side === "old" ? "−" : "+"}${editor.target.lineNumber}`;
  const header = useMemo(
    () => ({
      title: t("review.comment.label"),
      subtitle: <Text style={styles.context}>{context}</Text>,
    }),
    [context, t],
  );
  const { onSaveEditor, onCancelEditor } = reviewActions;
  const handleSave = useCallback(() => onSaveEditor(editor.body), [onSaveEditor, editor.body]);
  const canSave = editor.body.trim().length > 0;
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          size="md"
          variant="secondary"
          accessibilityLabel={t("review.comment.cancelAccessibility")}
          onPress={onCancelEditor}
        >
          {t("review.comment.cancel")}
        </Button>
        <Button
          size="md"
          variant="default"
          accessibilityLabel={t("review.comment.saveAccessibility")}
          disabled={!canSave}
          onPress={handleSave}
        >
          {t("common.actions.save")}
        </Button>
      </View>
    ),
    [canSave, handleSave, onCancelEditor, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onCancelEditor}
      snapPoints={COMMENT_SNAP_POINTS}
      scrollable={false}
      testID="review-comment-sheet"
      footer={footer}
    >
      <FormTextInput
        key={editor.target.key + (editor.commentId ?? "new")}
        size="md"
        multiline
        accessibilityLabel={t("review.comment.label")}
        placeholder={t("review.comment.placeholder")}
        initialValue={editor.body}
        onChangeText={onChangeBody}
        style={styles.input}
      />
    </AdaptiveModalSheet>
  );
}

const COMMENT_SNAP_POINTS = ["50%", "90%"];

const styles = StyleSheet.create((theme) => ({
  context: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  input: { flex: 1, minHeight: 0, textAlignVertical: "top" },
  actions: { flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
