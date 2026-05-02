import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import {
  Pressable,
  type PressableStateCallbackType,
  Text,
  TextInput,
  type TextStyle,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { isWeb } from "@/constants/platform";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useWorkspaceFocusRestoration } from "@/workspace/focus";
import { useReviewDraftComments, useReviewDraftStore, type ReviewDraftComment } from "./store";
import { buildReviewableDiffTargetKey, type ReviewableDiffTarget } from "@/utils/diff-layout";

type PressableState = PressableStateCallbackType & { hovered?: boolean };
type WebTextInputRef = TextInput & {
  getNativeElement?: () => unknown;
  getNativeRef?: () => unknown;
};

function iconButtonStyle({ hovered, pressed }: PressableState): StyleProp<ViewStyle> {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

function iconButtonDestructiveStyle({ hovered, pressed }: PressableState): StyleProp<ViewStyle> {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonDestructiveHovered];
}

function getWebTextInputElement(input: TextInput | null): HTMLElement | null {
  if (!isWeb || typeof HTMLElement === "undefined" || !input) {
    return null;
  }
  const webInput = input as WebTextInputRef;
  const element = webInput.getNativeElement?.() ?? webInput.getNativeRef?.() ?? input;
  return element instanceof HTMLElement ? element : null;
}

function getCanShowReviewKeyboardHints(): boolean {
  if (!isWeb || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function useCanShowReviewKeyboardHints(): boolean {
  const [canShowHints, setCanShowHints] = useState(getCanShowReviewKeyboardHints);

  useEffect(() => {
    if (!isWeb || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const handleChange = () => setCanShowHints(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener?.("change", handleChange);
    return () => {
      mediaQuery.removeEventListener?.("change", handleChange);
    };
  }, []);

  return canShowHints;
}

export const INLINE_REVIEW_COMMENT_HEIGHT = 72;
export const INLINE_REVIEW_EDITOR_HEIGHT = 132;
const INLINE_REVIEW_GAP = 6;
export const SMALL_ACTION_HIT_SLOP = 8;
const REVIEW_CANCEL_SHORTCUT_KEYS: ShortcutKey[] = ["Esc"];
const REVIEW_SAVE_SHORTCUT_KEYS: ShortcutKey[] = ["mod", "Enter"];

export interface InlineReviewEditorState {
  target: ReviewableDiffTarget;
  commentId: string | null;
  body: string;
}

export interface InlineReviewActions {
  commentsByTarget: ReadonlyMap<string, ReviewDraftComment[]>;
  editor: InlineReviewEditorState | null;
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
  isLineHovered = false,
  onStartComment,
  style,
}: {
  children: ReactNode;
  reviewTarget: ReviewableDiffTarget | null | undefined;
  comments: readonly ReviewDraftComment[];
  isEditorOpen: boolean;
  isLineHovered?: boolean;
  onStartComment: (target: ReviewableDiffTarget) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { theme } = useUnistyles();
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

  const labelStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.gutterLabel, hasComments && styles.gutterLabelActive],
    [hasComments],
  );

  return (
    <Pressable
      accessibilityRole={canComment ? "button" : undefined}
      accessibilityLabel={canComment ? "Add review comment" : undefined}
      hitSlop={canComment ? SMALL_ACTION_HIT_SLOP : undefined}
      disabled={!canComment}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={pressableStyle}
    >
      <View style={styles.gutterInner}>
        <View style={labelStyle}>
          {children}
          {showAction ? (
            <View style={styles.gutterActionIcon}>
              <Plus size={16} strokeWidth={2.4} color={theme.colors.accentForeground} />
            </View>
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
      { minHeight: height },
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
  const { theme } = useUnistyles();

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
          accessibilityLabel="Edit review comment"
          testID={`review-comment-edit-${comment.id}`}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={handleEdit}
          style={iconButtonStyle}
        >
          <Pencil size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete review comment"
          testID={`review-comment-delete-${comment.id}`}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={handleDelete}
          style={iconButtonDestructiveStyle}
        >
          <Trash2 size={14} color={theme.colors.destructive} />
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
  const focus = useWorkspaceFocusRestoration();
  const canShowKeyboardHints = useCanShowReviewKeyboardHints();
  const [body, setBody] = useState(initialBody);
  const [isFocused, setIsFocused] = useState(false);
  const trimmedBody = body.trim();
  const canSave = trimmedBody.length > 0;
  const showKeyboardHints = isFocused && canShowKeyboardHints;

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
  const cancelShortcut = useMemo(
    () => (showKeyboardHints ? <Shortcut keys={REVIEW_CANCEL_SHORTCUT_KEYS} /> : null),
    [showKeyboardHints],
  );
  const saveShortcut = useMemo(
    () => (showKeyboardHints ? <Shortcut keys={REVIEW_SAVE_SHORTCUT_KEYS} /> : null),
    [showKeyboardHints],
  );

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
        accessibilityLabel="Review comment"
        testID={testID ? `${testID}-input` : undefined}
        placeholder="Leave a comment"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        value={body}
        onChangeText={setBody}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={inputStyle}
      />
      <View style={styles.editorActions}>
        <Button
          accessibilityLabel="Cancel review comment"
          testID={testID ? `${testID}-cancel` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          onPress={onCancel}
          variant="ghost"
          size="xs"
          trailing={cancelShortcut}
        >
          Cancel
        </Button>
        <Button
          accessibilityLabel="Save review comment"
          testID={testID ? `${testID}-save` : undefined}
          hitSlop={SMALL_ACTION_HIT_SLOP}
          disabled={!canSave}
          onPress={handleSave}
          variant="default"
          size="xs"
          trailing={saveShortcut}
        >
          Comment
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  gutterInner: {
    minHeight: theme.lineHeight.diff,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  gutterLabel: {
    width: "100%",
    minWidth: 0,
    height: theme.lineHeight.diff,
    alignItems: "center",
    justifyContent: "center",
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
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    elevation: 10,
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
}));
