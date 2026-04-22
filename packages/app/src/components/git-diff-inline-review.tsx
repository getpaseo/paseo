import React, { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MessageCircle, Pencil, Trash2 } from "lucide-react-native";
import { Pressable, Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { isNative, isWeb } from "@/constants/platform";
import type { ReviewDraftComment } from "@/stores/review-draft-store";
import { buildReviewableDiffTargetKey, type ReviewableDiffTarget } from "@/utils/diff-layout";

export const INLINE_REVIEW_COMMENT_HEIGHT = 72;
export const INLINE_REVIEW_EDITOR_HEIGHT = 132;
const INLINE_REVIEW_GAP = 6;
export const SMALL_ACTION_HIT_SLOP = 8;

export interface InlineReviewEditorState {
  target: ReviewableDiffTarget;
  commentId: string | null;
  body: string;
}

export interface InlineReviewActions {
  commentsByTarget: ReadonlyMap<string, ReviewDraftComment[]>;
  editor: InlineReviewEditorState | null;
  showPersistentAction: boolean;
  onStartComment: (target: ReviewableDiffTarget) => void;
  onEditComment: (target: ReviewableDiffTarget, comment: ReviewDraftComment) => void;
  onCancelEditor: () => void;
  onSaveEditor: (body: string) => void;
  onDeleteComment: (id: string) => void;
}

export function groupInlineReviewCommentsByTarget(
  comments: readonly ReviewDraftComment[],
): Map<string, ReviewDraftComment[]> {
  const grouped = new Map<string, ReviewDraftComment[]>();
  for (const comment of comments) {
    const key = buildReviewableDiffTargetKey(comment);
    grouped.set(key, [...(grouped.get(key) ?? []), comment]);
  }
  return grouped;
}

export function isInlineReviewEditorForTarget(
  editor: InlineReviewEditorState | null,
  target: ReviewableDiffTarget | null | undefined,
): boolean {
  return Boolean(
    editor &&
      target &&
      buildReviewableDiffTargetKey(editor.target) === buildReviewableDiffTargetKey(target),
  );
}

export function getInlineReviewThreadState(input: {
  reviewTarget: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  comments: ReviewDraftComment[];
  hasEditor: boolean;
  editingCommentId: string | null;
  height: number;
} | null {
  const { reviewTarget, reviewActions } = input;
  if (!reviewTarget || !reviewActions) {
    return null;
  }

  const comments = reviewActions.commentsByTarget.get(reviewTarget.key) ?? [];
  const editorForTarget = isInlineReviewEditorForTarget(reviewActions.editor, reviewTarget)
    ? reviewActions.editor
    : null;
  const hasEditor = editorForTarget !== null;
  const editingCommentId = editorForTarget?.commentId ?? null;
  const editingExisting =
    editingCommentId !== null && comments.some((comment) => comment.id === editingCommentId);

  const visibleCommentCount = editingExisting ? comments.length - 1 : comments.length;
  const editorCount = hasEditor ? 1 : 0;
  const visibleBlockCount = visibleCommentCount + editorCount;
  if (visibleBlockCount === 0) {
    return null;
  }

  const height =
    visibleCommentCount * INLINE_REVIEW_COMMENT_HEIGHT +
    editorCount * INLINE_REVIEW_EDITOR_HEIGHT +
    Math.max(0, visibleBlockCount - 1) * INLINE_REVIEW_GAP;

  return { comments, hasEditor, editingCommentId, height };
}

export function getSplitInlineReviewThreadState(input: {
  left: ReviewableDiffTarget | null | undefined;
  right: ReviewableDiffTarget | null | undefined;
  reviewActions?: InlineReviewActions;
}): {
  left: ReturnType<typeof getInlineReviewThreadState>;
  right: ReturnType<typeof getInlineReviewThreadState>;
  height: number;
} | null {
  const left = getInlineReviewThreadState({
    reviewTarget: input.left,
    reviewActions: input.reviewActions,
  });
  const right = getInlineReviewThreadState({
    reviewTarget: input.right,
    reviewActions: input.reviewActions,
  });
  const height = Math.max(left?.height ?? 0, right?.height ?? 0);
  if (height === 0) {
    return null;
  }
  return { left, right, height };
}

export function InlineReviewGutterCell({
  children,
  reviewTarget,
  comments,
  isEditorOpen,
  showPersistentAction,
  onStartComment,
  style,
}: {
  children: ReactNode;
  reviewTarget: ReviewableDiffTarget | null | undefined;
  comments: readonly ReviewDraftComment[];
  isEditorOpen: boolean;
  showPersistentAction: boolean;
  onStartComment: (target: ReviewableDiffTarget) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useUnistyles();
  const canComment = Boolean(reviewTarget);
  const hasComments = comments.length > 0;

  return (
    <Pressable
      accessibilityRole={canComment ? "button" : undefined}
      accessibilityLabel={canComment ? "Add review comment" : undefined}
      hitSlop={canComment ? SMALL_ACTION_HIT_SLOP : undefined}
      disabled={!canComment}
      onPress={() => {
        if (reviewTarget) {
          onStartComment(reviewTarget);
        }
      }}
      style={({ hovered, pressed }) => [
        style,
        canComment && (hovered || pressed) && styles.gutterHovered,
      ]}
    >
      {({ hovered, pressed }) => {
        const showAction =
          canComment &&
          (hovered || pressed || isNative || showPersistentAction || hasComments || isEditorOpen);
        return (
          <View style={styles.gutterInner}>
            <View style={[styles.gutterLabel, hasComments && styles.gutterLabelActive]}>
              {showAction ? (
                <MessageCircle
                  size={13}
                  strokeWidth={hasComments ? 2.25 : 1.75}
                  color={hasComments ? theme.colors.accent : theme.colors.foregroundMuted}
                />
              ) : (
                children
              )}
            </View>
          </View>
        );
      }}
    </Pressable>
  );
}

export function InlineReviewThread({
  reviewTarget,
  reviewActions,
  height,
  viewportWidth,
  pinToViewport = false,
  testID,
}: {
  reviewTarget: ReviewableDiffTarget;
  reviewActions: InlineReviewActions;
  height: number;
  viewportWidth?: number;
  pinToViewport?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const comments = reviewActions.commentsByTarget.get(reviewTarget.key) ?? [];
  const editor = isInlineReviewEditorForTarget(reviewActions.editor, reviewTarget)
    ? reviewActions.editor
    : null;
  const editingCommentId = editor?.commentId ?? null;
  const editingExisting =
    editingCommentId !== null && comments.some((comment) => comment.id === editingCommentId);

  const renderEditor = () =>
    editor ? (
      <InlineReviewEditor
        key={editingCommentId ?? "new"}
        initialBody={editor.body}
        onCancel={reviewActions.onCancelEditor}
        onSave={reviewActions.onSaveEditor}
        testID="inline-review-editor"
      />
    ) : null;

  return (
    <View
      style={[
        styles.threadContainer,
        getInlineReviewThreadViewportStyle({ viewportWidth, pinToViewport }),
        { minHeight: height },
      ]}
      testID={testID}
    >
      {comments.map((comment) => {
        if (comment.id === editingCommentId) {
          return <React.Fragment key={comment.id}>{renderEditor()}</React.Fragment>;
        }
        return (
          <View key={comment.id} style={styles.commentBlock}>
            <Text style={styles.commentBody} numberOfLines={2}>
              {comment.body}
            </Text>
            <View style={styles.commentActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit review comment"
                testID={`review-comment-edit-${comment.id}`}
                hitSlop={SMALL_ACTION_HIT_SLOP}
                onPress={() => reviewActions.onEditComment(reviewTarget, comment)}
                style={({ hovered, pressed }) => [
                  styles.iconButton,
                  (hovered || pressed) && styles.iconButtonHovered,
                ]}
              >
                <Pencil size={14} color={theme.colors.foregroundMuted} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete review comment"
                testID={`review-comment-delete-${comment.id}`}
                hitSlop={SMALL_ACTION_HIT_SLOP}
                onPress={() => reviewActions.onDeleteComment(comment.id)}
                style={({ hovered, pressed }) => [
                  styles.iconButton,
                  (hovered || pressed) && styles.iconButtonDestructiveHovered,
                ]}
              >
                <Trash2 size={14} color={theme.colors.destructive} />
              </Pressable>
            </View>
          </View>
        );
      })}
      {editor && !editingExisting ? renderEditor() : null}
    </View>
  );
}

export function getInlineReviewThreadViewportStyle({
  viewportWidth,
  pinToViewport,
}: {
  viewportWidth?: number;
  pinToViewport: boolean;
}): StyleProp<ViewStyle> {
  const widthStyle = viewportWidth && viewportWidth > 0 ? { width: viewportWidth } : null;
  if (!pinToViewport || !isWeb) {
    return widthStyle;
  }
  const stickyStyle = { position: "sticky", left: 0 } as unknown as ViewStyle;
  return [stickyStyle, widthStyle];
}

export function InlineReviewEditor({
  initialBody,
  onCancel,
  onSave,
  testID,
}: {
  initialBody: string;
  onCancel: () => void;
  onSave: (body: string) => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInput | null>(null);
  const [body, setBody] = useState(initialBody);
  const [isFocused, setIsFocused] = useState(false);
  const trimmedBody = body.trim();
  const canSave = trimmedBody.length > 0;

  useEffect(() => {
    setBody(initialBody);
  }, [initialBody]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <View style={styles.editorBlock} testID={testID}>
      <TextInput
        ref={inputRef}
        accessibilityLabel="Review comment"
        testID={testID ? `${testID}-input` : undefined}
        placeholder="Leave a comment"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        value={body}
        onChangeText={setBody}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        style={[styles.editorInput, isFocused && styles.editorInputFocused]}
      />
      <View style={styles.editorActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel review comment"
          testID={testID ? `${testID}-cancel` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={onCancel}
          style={({ hovered, pressed }) => [
            styles.ghostButton,
            (hovered || pressed) && styles.ghostButtonHovered,
          ]}
        >
          <Text style={styles.ghostButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save review comment"
          testID={testID ? `${testID}-save` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          disabled={!canSave}
          onPress={() => onSave(trimmedBody)}
          style={({ hovered, pressed }) => [
            styles.saveButton,
            !canSave && styles.saveButtonDisabled,
            canSave && (hovered || pressed) && styles.saveButtonHovered,
          ]}
        >
          <Text style={styles.saveButtonText}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  gutterHovered: {
    backgroundColor: theme.colors.surface2,
  },
  gutterInner: {
    minHeight: theme.lineHeight.diff,
    alignItems: "center",
    justifyContent: "center",
  },
  gutterLabel: {
    width: "100%",
    minWidth: 0,
    height: theme.lineHeight.diff,
    alignItems: "center",
    justifyContent: "center",
  },
  gutterLabelActive: {
    backgroundColor: theme.colors.surface2,
  },
  threadContainer: {
    flex: 1,
    minWidth: 0,
    gap: INLINE_REVIEW_GAP,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  commentBlock: {
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commentBody: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  commentActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  iconButton: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    ...(isWeb
      ? {
          transitionProperty: "background-color",
          transitionDuration: "120ms",
          transitionTimingFunction: "ease-in-out",
        }
      : {}),
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  iconButtonDestructiveHovered: {
    backgroundColor: theme.colors.surface3,
  },
  editorBlock: {
    minHeight: INLINE_REVIEW_EDITOR_HEIGHT,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
  },
  editorInput: {
    flex: 1,
    minHeight: 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    textAlignVertical: "top",
    ...(isWeb
      ? {
          outlineWidth: 0,
          outlineColor: "transparent",
        }
      : {}),
  },
  editorInputFocused: {
    borderColor: theme.colors.accent,
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  ghostButton: {
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  ghostButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  ghostButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  saveButton: {
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  saveButtonHovered: {
    opacity: 0.9,
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
}));
