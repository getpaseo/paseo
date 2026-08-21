import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import {
  Pressable,
  type PressableStateCallbackType,
  Text,
  type TextStyle,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { useWorkspaceFocusRestoration } from "@/workspace/focus";
import { useReviewDraftComments, useReviewDraftStore, type ReviewDraftComment } from "./store";
import { buildReviewableDiffTargetKey, type ReviewableDiffTarget } from "@/utils/diff-layout";
import {
  INLINE_REVIEW_EDITOR_HEIGHT,
  INLINE_REVIEW_GAP,
  INLINE_REVIEW_VERTICAL_PADDING,
  isInlineReviewEditorForTarget,
  type InlineReviewActions,
  type InlineReviewEditorState,
} from "./geometry";

type PressableState = PressableStateCallbackType & { hovered?: boolean };
function iconButtonStyle({ hovered, pressed }: PressableState): StyleProp<ViewStyle> {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

function iconButtonDestructiveStyle({ hovered, pressed }: PressableState): StyleProp<ViewStyle> {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonDestructiveHovered];
}

function getWebTextInputElement(input: EditingTextInputHandle | null): HTMLElement | null {
  if (!isWeb || typeof HTMLElement === "undefined" || !input) {
    return null;
  }
  const element = input.getNativeRef();
  return element instanceof HTMLElement ? element : null;
}

export const SMALL_ACTION_HIT_SLOP = 8;
const foregroundMutedIconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveIconColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const accentForegroundIconColorMapping = (theme: Theme) => ({
  color: theme.colors.accentForeground,
});
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash2 = withUnistyles(Trash2);

function InlineReviewAddIcon({ style, testID }: { style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.gutterActionVisual, style]} testID={testID}>
      <ThemedPlus size={16} strokeWidth={2.4} uniProps={accentForegroundIconColorMapping} />
    </View>
  );
}

export function InlineReviewAddButton({
  onPress,
  style,
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("review.comment.add")}
      hitSlop={SMALL_ACTION_HIT_SLOP}
      onPress={onPress}
      style={[styles.gutterActionVisual, style]}
    >
      <ThemedPlus size={16} strokeWidth={2.4} uniProps={accentForegroundIconColorMapping} />
    </Pressable>
  );
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

export function useInlineReviewController(input: { reviewDraftKey: string }): InlineReviewActions {
  const reviewComments = useReviewDraftComments(input.reviewDraftKey);
  const commentsByTarget = useMemo(
    () => groupInlineReviewCommentsByTarget(reviewComments),
    [reviewComments],
  );
  const [editor, setEditor] = useState<InlineReviewEditorState | null>(null);
  const addComment = useReviewDraftStore((state) => state.addComment);
  const updateComment = useReviewDraftStore((state) => state.updateComment);
  const deleteComment = useReviewDraftStore((state) => state.deleteComment);

  useEffect(() => {
    setEditor(null);
  }, [input.reviewDraftKey]);

  const handleStartComment = useCallback((target: ReviewableDiffTarget) => {
    setEditor({ target, commentId: null, body: "" });
  }, []);

  const handleEditComment = useCallback(
    (target: ReviewableDiffTarget, comment: ReviewDraftComment) => {
      setEditor({ target, commentId: comment.id, body: comment.body });
    },
    [],
  );

  const handleCancelEditor = useCallback(() => {
    setEditor(null);
  }, []);

  const handleSaveEditor = useCallback(
    (body: string) => {
      const trimmedBody = body.trim();
      if (!editor || trimmedBody.length === 0) {
        return;
      }

      if (editor.commentId) {
        updateComment({
          key: input.reviewDraftKey,
          id: editor.commentId,
          updates: { body: trimmedBody },
        });
      } else {
        addComment({
          key: input.reviewDraftKey,
          comment: {
            filePath: editor.target.filePath,
            side: editor.target.side,
            lineNumber: editor.target.lineNumber,
            body: trimmedBody,
          },
        });
      }
      setEditor(null);
    },
    [addComment, editor, input.reviewDraftKey, updateComment],
  );

  const handleDeleteComment = useCallback(
    (id: string) => {
      deleteComment({ key: input.reviewDraftKey, id });
      setEditor((current) => (current?.commentId === id ? null : current));
    },
    [deleteComment, input.reviewDraftKey],
  );

  return useMemo<InlineReviewActions>(
    () => ({
      commentsByTarget,
      editor,
      onStartComment: handleStartComment,
      onEditComment: handleEditComment,
      onCancelEditor: handleCancelEditor,
      onSaveEditor: handleSaveEditor,
      onDeleteComment: handleDeleteComment,
    }),
    [
      commentsByTarget,
      editor,
      handleCancelEditor,
      handleDeleteComment,
      handleEditComment,
      handleSaveEditor,
      handleStartComment,
    ],
  );
}

export function InlineReviewGutterCell({
  children,
  reviewTarget,
  comments,
  isLineHovered = false,
  lineHeight,
  onStartComment,
  style,
  actionTestID,
}: {
  children: ReactNode;
  reviewTarget: ReviewableDiffTarget | null | undefined;
  comments: readonly ReviewDraftComment[];
  isEditorOpen: boolean;
  isLineHovered?: boolean;
  lineHeight?: number;
  onStartComment: (target: ReviewableDiffTarget) => void;
  style?: StyleProp<ViewStyle>;
  actionTestID?: string;
}) {
  const { t } = useTranslation();
  const canComment = Boolean(reviewTarget);
  const hasComments = comments.length > 0;
  const [isGutterHovered, setIsGutterHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [isDismissedAfterPress, setIsDismissedAfterPress] = useState(false);
  const isInteractionActive = isGutterHovered || isLineHovered || isPressed;
  const showAction = canComment && isInteractionActive && !isDismissedAfterPress;

  const handlePress = useCallback(() => {
    if (reviewTarget) {
      setIsDismissedAfterPress(true);
      onStartComment(reviewTarget);
    }
  }, [reviewTarget, onStartComment]);

  const handleHoverIn = useCallback(() => {
    setIsGutterHovered(true);
  }, []);

  const handleHoverOut = useCallback(() => {
    setIsGutterHovered(false);
  }, []);

  const handlePressIn = useCallback(() => {
    setIsPressed(true);
  }, []);

  const handlePressOut = useCallback(() => {
    setIsPressed(false);
  }, []);

  useEffect(() => {
    if (!isInteractionActive) {
      setIsDismissedAfterPress(false);
    }
  }, [isInteractionActive]);

  const pressableStyle = useCallback((): StyleProp<ViewStyle> => style, [style]);
  const lineHeightStyle = useMemo<StyleProp<ViewStyle>>(
    () =>
      lineHeight !== undefined
        ? inlineUnistylesStyle({ height: lineHeight, minHeight: lineHeight })
        : null,
    [lineHeight],
  );

  const labelStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.gutterLabel, lineHeightStyle, hasComments && styles.gutterLabelActive],
    [hasComments, lineHeightStyle],
  );
  const innerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.gutterInner, lineHeightStyle],
    [lineHeightStyle],
  );
  const actionIconStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.gutterActionIcon,
      lineHeight !== undefined && inlineUnistylesStyle({ top: Math.floor((lineHeight - 22) / 2) }),
    ],
    [lineHeight],
  );

  return (
    <Pressable
      accessibilityRole={canComment ? "button" : undefined}
      accessibilityLabel={canComment ? t("review.comment.add") : undefined}
      hitSlop={canComment ? SMALL_ACTION_HIT_SLOP : undefined}
      disabled={!canComment}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={pressableStyle}
    >
      <View style={innerStyle}>
        <View style={labelStyle}>
          {children}
          {showAction ? (
            <InlineReviewAddIcon style={actionIconStyle} testID={actionTestID} />
          ) : null}
        </View>
      </View>
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
  const comments = reviewActions.commentsByTarget.get(reviewTarget.key) ?? [];
  const editor = isInlineReviewEditorForTarget(reviewActions.editor, reviewTarget)
    ? reviewActions.editor
    : null;
  const editingCommentId = editor?.commentId ?? null;
  const editingExisting =
    editingCommentId !== null && comments.some((comment) => comment.id === editingCommentId);

  const editorElement = editor ? (
    <InlineReviewEditor
      key={editingCommentId ?? "new"}
      initialBody={editor.body}
      onCancel={reviewActions.onCancelEditor}
      onSave={reviewActions.onSaveEditor}
      testID="inline-review-editor"
    />
  ) : null;

  const containerStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.threadContainer,
      getInlineReviewThreadViewportStyle({ viewportWidth, pinToViewport }),
      inlineUnistylesStyle({ minHeight: height }),
    ],
    [viewportWidth, pinToViewport, height],
  );

  return (
    <View style={containerStyle} testID={testID}>
      {comments.map((comment) => {
        if (comment.id === editingCommentId) {
          return <React.Fragment key={comment.id}>{editorElement}</React.Fragment>;
        }
        return (
          <CommentRow
            key={comment.id}
            comment={comment}
            reviewTarget={reviewTarget}
            onEditComment={reviewActions.onEditComment}
            onDeleteComment={reviewActions.onDeleteComment}
          />
        );
      })}
      {editor && !editingExisting ? editorElement : null}
    </View>
  );
}

function CommentRow({
  comment,
  reviewTarget,
  onEditComment,
  onDeleteComment,
}: {
  comment: ReviewDraftComment;
  reviewTarget: ReviewableDiffTarget;
  onEditComment: (target: ReviewableDiffTarget, comment: ReviewDraftComment) => void;
  onDeleteComment: (id: string) => void;
}) {
  const { t } = useTranslation();
  const handleEdit = useCallback(
    () => onEditComment(reviewTarget, comment),
    [onEditComment, reviewTarget, comment],
  );

  const handleDelete = useCallback(
    () => onDeleteComment(comment.id),
    [onDeleteComment, comment.id],
  );

  return (
    <View style={styles.commentBlock}>
      <Text style={styles.commentBody} numberOfLines={2}>
        {comment.body}
      </Text>
      <View style={styles.commentActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("review.comment.edit")}
          testID={`review-comment-edit-${comment.id}`}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={handleEdit}
          style={iconButtonStyle}
        >
          <ThemedPencil size={14} uniProps={foregroundMutedIconColorMapping} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("review.comment.delete")}
          testID={`review-comment-delete-${comment.id}`}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={handleDelete}
          style={iconButtonDestructiveStyle}
        >
          <ThemedTrash2 size={14} uniProps={destructiveIconColorMapping} />
        </Pressable>
      </View>
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
  const widthStyle =
    viewportWidth && viewportWidth > 0 ? inlineUnistylesStyle({ width: viewportWidth }) : null;
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
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const focus = useWorkspaceFocusRestoration();
  const [body, setBody] = useState(initialBody);
  const [isFocused, setIsFocused] = useState(false);
  const trimmedBody = body.trim();
  const canSave = trimmedBody.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleFocus = useCallback(() => {
    focus.unfocus();
    setIsFocused(true);
  }, [focus]);
  const handleBlur = useCallback(() => {
    setIsFocused(false);
    focus.restore();
  }, [focus]);
  const handleSave = useCallback(() => onSave(trimmedBody), [onSave, trimmedBody]);

  useEffect(() => {
    const element = getWebTextInputElement(inputRef.current);
    if (!element) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }

      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      if (!event.metaKey && !event.ctrlKey) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!canSave) {
        return;
      }
      handleSave();
    };

    element.addEventListener("keydown", handleKeyDown);
    return () => {
      element.removeEventListener("keydown", handleKeyDown);
    };
  }, [canSave, handleSave, onCancel]);

  const inputStyle = useMemo<StyleProp<TextStyle>>(
    () => [styles.editorInput, isFocused && styles.editorInputFocused],
    [isFocused],
  );

  return (
    <View style={styles.editorBlock} testID={testID}>
      <TextInput
        ref={inputRef}
        accessibilityLabel={t("review.comment.label")}
        testID={testID ? `${testID}-input` : undefined}
        placeholder={t("review.comment.placeholder")}
        placeholderTextColor={styles.placeholderColor.color}
        multiline
        initialValue={body}
        onChangeText={setBody}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={inputStyle}
      />
      <View style={styles.editorActions}>
        <Button
          accessibilityLabel={t("review.comment.cancelAccessibility")}
          testID={testID ? `${testID}-cancel` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={onCancel}
          variant="ghost"
          size="xs"
        >
          {t("review.comment.cancel")}
        </Button>
        <Button
          accessibilityLabel={t("review.comment.saveAccessibility")}
          testID={testID ? `${testID}-save` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          disabled={!canSave}
          onPress={handleSave}
          variant="default"
          size="xs"
        >
          {t("review.comment.save")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  gutterInner: {
    minHeight: theme.lineHeight.diff,
    alignItems: "stretch",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  gutterLabel: {
    width: "100%",
    minWidth: 0,
    height: theme.lineHeight.diff,
    alignItems: "stretch",
    justifyContent: "flex-start",
    position: "relative",
    overflow: "visible",
  },
  gutterLabelActive: {
    backgroundColor: theme.colors.surface2,
  },
  gutterActionIcon: {
    position: "absolute",
    right: -10,
    top: Math.floor((theme.lineHeight.diff - 22) / 2),
  },
  gutterActionVisual: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    elevation: 10,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  threadContainer: {
    flex: 1,
    minWidth: 0,
    gap: INLINE_REVIEW_GAP,
    paddingVertical: INLINE_REVIEW_VERTICAL_PADDING,
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
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.4,
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
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.4,
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
}));
