import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ArrowUp, Check, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Path } from "react-native-svg";
import type { SelectedTextComposerAttachment } from "@/attachments/types";
import { Button } from "@/components/ui/button";
import { getContentAdornmentRoot } from "@/lib/overlay-root";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { createAssistantSelectionClipboardContent } from "./content.web";
import { MARKDOWN_COPY_IGNORE_ATTRIBUTE } from "./markup";
import type { AssistantSelectionAnnotation, SelectedTextAnnotationEdit } from "./types";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  visible?: boolean;
  onCommentSelection?: (annotation: AssistantSelectionAnnotation) => void;
  addToCommentLabel?: string;
  addToConversationLabel?: string;
  commentPlaceholder?: string;
  saveCommentLabel?: string;
  cancelCommentLabel?: string;
  selectedTextAnnotationToEdit?: {
    id: string;
    text: string;
    sourceMessageId?: string;
    occurrence?: number;
    comment?: string;
  } | null;
  selectedTextAnnotations?: readonly SelectedTextComposerAttachment[];
  onOpenAnnotation?: (annotation: SelectedTextComposerAttachment) => void;
  onEditComment?: (input: SelectedTextAnnotationEdit) => void;
  onDismissEditComment?: () => void;
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
const EDITOR_GUTTER = 16;
const EDITOR_MAX_WIDTH = 420;
const COMPACT_EDITOR_MAX_WIDTH = 360;
const COMPACT_EDITOR_MIN_INPUT_HEIGHT = 44;
const COMPACT_EDITOR_MAX_INPUT_HEIGHT = 112;
const EDITOR_MIN_WORKING_HEIGHT = 160;
const ANNOTATION_MARKER_Z_INDEX = 8;
const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';
const ASSISTANT_MESSAGE_ITEM_SELECTOR = '[data-testid^="assistant-message-item:"]';
const CHAT_SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';
const COMPOSER_INPUT_AREA_SELECTOR = '[data-testid="composer-input-area"]';
const markdownParser = createAssistantMarkdownParser();

interface EditorPosition {
  left: number;
  top: number;
  placeBelow: boolean;
  centered: boolean;
}

interface SelectionAction {
  annotation: AssistantSelectionAnnotation;
  range: Range;
  buttonLeft: number;
  buttonTop: number;
  editorPosition: EditorPosition;
}

interface CommentEditorState extends EditorPosition {
  annotation: AssistantSelectionAnnotation;
  comment: string;
  attachmentId?: string;
}

interface SelectionHighlightRect {
  key: string;
  style: CSSProperties;
}

interface AnnotationMarker {
  annotation: SelectedTextComposerAttachment;
  id: string;
  left: number;
  number: number;
  style: CSSProperties;
  top: number;
}

const EMPTY_SELECTED_TEXT_ANNOTATIONS: readonly SelectedTextComposerAttachment[] = [];

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedAnnotationMarkerShape = withUnistyles(AnnotationMarkerShape);
const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconSaveMapping = (theme: Theme) => ({ color: theme.colors.background });
const annotationMarkerShapeMapping = (theme: Theme) => ({
  fill: theme.colors.palette.blue[500],
  stroke: theme.colors.palette.white,
});

function annotationMarkerButtonStyle({
  pressed,
}: PressableStateCallbackType): StyleProp<ViewStyle> {
  return [styles.annotationMarkerButton, pressed ? styles.annotationMarkerPressed : null];
}

function visibleValue<T>(visible: boolean, value: T, hiddenValue: T): T {
  return visible ? value : hiddenValue;
}

export function AssistantSelectionCopySurface({
  children,
  style,
  visible = true,
  onCommentSelection,
  addToCommentLabel = "Add to comment",
  addToConversationLabel = "Add to conversation",
  commentPlaceholder = "Add a comment about this selection",
  saveCommentLabel = "Save",
  cancelCommentLabel = "Cancel",
  selectedTextAnnotations = EMPTY_SELECTED_TEXT_ANNOTATIONS,
  onOpenAnnotation,
  selectedTextAnnotationToEdit = null,
  onEditComment,
  onDismissEditComment,
}: AssistantSelectionCopySurfaceProps) {
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);
  const [commentEditor, setCommentEditor] = useState<CommentEditorState | null>(null);
  const [isEditorFocused, setIsEditorFocused] = useState(false);
  const [compactInputHeight, setCompactInputHeight] = useState(COMPACT_EDITOR_MIN_INPUT_HEIGHT);
  const [selectionHighlightRects, setSelectionHighlightRects] = useState<SelectionHighlightRect[]>(
    [],
  );
  const [annotationMarkers, setAnnotationMarkers] = useState<AnnotationMarker[]>([]);
  const editorElementRef = useRef<HTMLDivElement | null>(null);
  const commentEditorRef = useRef<CommentEditorState | null>(null);
  const activeAnnotationRangeRef = useRef<Range | null>(null);
  const visibleSelectedTextAnnotations = visibleValue(
    visible,
    selectedTextAnnotations,
    EMPTY_SELECTED_TEXT_ANNOTATIONS,
  );
  const visibleOnCommentSelection = visibleValue(visible, onCommentSelection, undefined);
  const visibleSelectedTextAnnotationToEdit = visibleValue(
    visible,
    selectedTextAnnotationToEdit,
    null,
  );

  useEffect(() => {
    commentEditorRef.current = commentEditor;
  }, [commentEditor]);
  useKeepEditorInsideContentViewport(commentEditor, setCommentEditor, editorElementRef);

  const refreshAnnotationMarkers = useCallback(() => {
    setAnnotationMarkers((current) => {
      const next = getAnnotationMarkers(visibleSelectedTextAnnotations);
      return annotationMarkersEqual(current, next) ? current : next;
    });
  }, [visibleSelectedTextAnnotations]);

  useEffect(() => {
    let animationFrame = 0;
    let attemptsRemaining = 30;
    const refreshUntilMounted = () => {
      const markers = getAnnotationMarkers(visibleSelectedTextAnnotations);
      setAnnotationMarkers((current) =>
        annotationMarkersEqual(current, markers) ? current : markers,
      );
      if (markers.length < visibleSelectedTextAnnotations.length && attemptsRemaining > 0) {
        attemptsRemaining -= 1;
        animationFrame = window.requestAnimationFrame(refreshUntilMounted);
      }
    };
    refreshUntilMounted();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [visibleSelectedTextAnnotations]);

  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);

  const updateSelectionAction = useCallback(() => {
    if (!visibleOnCommentSelection) {
      return;
    }
    const selection = window.getSelection();
    const content = createAssistantSelectionClipboardContent(selection);
    if (!content || !selection || selection.rangeCount !== 1) {
      setSelectionAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const message = closestAssistantMessage(range);
    if (!message || (rect.width === 0 && rect.height === 0)) {
      setSelectionAction(null);
      return;
    }
    const sourceMessageId = getAssistantMessageId(message);
    const occurrence = getRangeTextOccurrence(message, content.plainText, range);
    setCommentEditor(null);
    setSelectionAction({
      annotation: {
        text: content.plainText,
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(occurrence != null ? { occurrence } : {}),
        comment: "",
      },
      range: range.cloneRange(),
      editorPosition: getEditorPosition(rect, COMPACT_EDITOR_MAX_WIDTH),
      ...getSelectionButtonPosition(rect),
    });
  }, [visibleOnCommentSelection]);

  useEffect(() => {
    if (!visibleOnCommentSelection && visibleSelectedTextAnnotations.length === 0) {
      return;
    }
    const clearSelectionAction = () => {
      setSelectionAction(null);
    };
    const hideSelectionActionWhenSelectionClears = () => {
      if (commentEditorRef.current) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        clearSelectionAction();
      }
    };
    const updateAnchoredSurface = (event?: Event) => {
      clearSelectionAction();
      if (event?.target instanceof Node && editorElementRef.current?.contains(event.target)) {
        return;
      }
      refreshAnnotationMarkers();
      const range = activeAnnotationRangeRef.current;
      const editor = commentEditorRef.current;
      if (!range || !editor) {
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelectionHighlightRects(editor.attachmentId ? getSelectionHighlightRects(range) : []);
      setCommentEditor((current) =>
        current
          ? {
              ...current,
              ...getEditorPosition(
                rect,
                current.attachmentId ? EDITOR_MAX_WIDTH : COMPACT_EDITOR_MAX_WIDTH,
              ),
            }
          : current,
      );
    };
    document.addEventListener("scroll", updateAnchoredSurface, true);
    document.addEventListener("selectionchange", hideSelectionActionWhenSelectionClears);
    window.addEventListener("resize", updateAnchoredSurface);
    const composerResizeObserver = new ResizeObserver(refreshAnnotationMarkers);
    for (const composer of document.querySelectorAll(COMPOSER_INPUT_AREA_SELECTOR)) {
      composerResizeObserver.observe(composer);
    }
    return () => {
      document.removeEventListener("scroll", updateAnchoredSurface, true);
      document.removeEventListener("selectionchange", hideSelectionActionWhenSelectionClears);
      window.removeEventListener("resize", updateAnchoredSurface);
      composerResizeObserver.disconnect();
    };
  }, [refreshAnnotationMarkers, visibleOnCommentSelection, visibleSelectedTextAnnotations.length]);

  const handleEditorMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);
  const handleSelectionButtonMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  }, []);
  const handleCommentChange = useCallback((comment: string) => {
    setCommentEditor((current) => (current ? { ...current, comment } : current));
  }, []);
  const handleCompactContentSizeChange = useCallback(
    (event: { nativeEvent: { contentSize: { height: number } } }) => {
      setCompactInputHeight(
        Math.min(
          COMPACT_EDITOR_MAX_INPUT_HEIGHT,
          Math.max(COMPACT_EDITOR_MIN_INPUT_HEIGHT, event.nativeEvent.contentSize.height),
        ),
      );
    },
    [],
  );
  const dismissCommentEditor = useCallback(() => {
    setCommentEditor(null);
    setIsEditorFocused(false);
    setSelectionHighlightRects([]);
    activeAnnotationRangeRef.current = null;
    onDismissEditComment?.();
  }, [onDismissEditComment]);
  useDismissEditorOnOutsideInteraction(commentEditor, editorElementRef, dismissCommentEditor);

  useEffect(() => {
    if (visible) return;
    setSelectionAction(null);
    setAnnotationMarkers([]);
    dismissCommentEditor();
  }, [dismissCommentEditor, visible]);
  const handleCancelComment = useCallback(() => dismissCommentEditor(), [dismissCommentEditor]);
  const handleEditorFocus = useCallback(() => setIsEditorFocused(true), []);
  const handleEditorBlur = useCallback(() => setIsEditorFocused(false), []);
  const handleOpenCommentEditor = useCallback(() => {
    if (!selectionAction || !onCommentSelection) {
      return;
    }
    setCommentEditor({
      annotation: selectionAction.annotation,
      ...selectionAction.editorPosition,
      comment: "",
    });
    activeAnnotationRangeRef.current = selectionAction.range;
    setCompactInputHeight(COMPACT_EDITOR_MIN_INPUT_HEIGHT);
    setSelectionAction(null);
  }, [onCommentSelection, selectionAction]);

  const handleSaveComment = useCallback(() => {
    if (!commentEditor) {
      return;
    }
    const comment = commentEditor.comment.trim();
    if (commentEditor.attachmentId && onEditComment) {
      onEditComment({ attachmentId: commentEditor.attachmentId, comment });
    } else if (onCommentSelection) {
      onCommentSelection({ ...commentEditor.annotation, comment });
    } else {
      return;
    }
    window.getSelection()?.removeAllRanges();
    setCommentEditor(null);
    setSelectionHighlightRects([]);
    activeAnnotationRangeRef.current = null;
  }, [commentEditor, onCommentSelection, onEditComment]);

  useEffect(() => {
    if (!visibleSelectedTextAnnotationToEdit) {
      activeAnnotationRangeRef.current = null;
      setSelectionHighlightRects([]);
      setCommentEditor(closeEditCommentEditor);
      return;
    }
    let animationFrame = 0;
    let attemptsRemaining = 20;
    const openAnnotationEditor = () => {
      const message = findMessageForAnnotation(visibleSelectedTextAnnotationToEdit);
      const range = message
        ? findTextRange(
            message,
            visibleSelectedTextAnnotationToEdit.text,
            visibleSelectedTextAnnotationToEdit.occurrence,
          )
        : null;
      if (!range && attemptsRemaining > 0) {
        attemptsRemaining -= 1;
        animationFrame = window.requestAnimationFrame(openAnnotationEditor);
        return;
      }
      activeAnnotationRangeRef.current = range;
      setSelectionHighlightRects(range ? getSelectionHighlightRects(range) : []);
      setCommentEditor({
        annotation: {
          text: visibleSelectedTextAnnotationToEdit.text,
          ...(visibleSelectedTextAnnotationToEdit.sourceMessageId
            ? { sourceMessageId: visibleSelectedTextAnnotationToEdit.sourceMessageId }
            : {}),
          ...(visibleSelectedTextAnnotationToEdit.occurrence != null
            ? { occurrence: visibleSelectedTextAnnotationToEdit.occurrence }
            : {}),
          comment: visibleSelectedTextAnnotationToEdit.comment ?? "",
        },
        attachmentId: visibleSelectedTextAnnotationToEdit.id,
        comment: visibleSelectedTextAnnotationToEdit.comment ?? "",
        ...getEditorPosition(range?.getBoundingClientRect() ?? null),
      });
      setSelectionAction(null);
    };
    openAnnotationEditor();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [visibleSelectedTextAnnotationToEdit]);

  const selectionButtonPositionStyle = useMemo<CSSProperties | undefined>(() => {
    if (!selectionAction) {
      return undefined;
    }
    return {
      position: "fixed",
      zIndex: 1000,
      pointerEvents: "auto",
      left: selectionAction.buttonLeft,
      top: selectionAction.buttonTop,
      transform: "translateY(-50%)",
    };
  }, [selectionAction]);

  const commentEditorPositionStyle = useMemo<CSSProperties | undefined>(() => {
    if (!commentEditor) {
      return undefined;
    }
    let transform = "translate(-50%, -100%)";
    if (commentEditor.centered) {
      transform = "translate(-50%, -50%)";
    } else if (commentEditor.placeBelow) {
      transform = "translate(-50%, 0)";
    }
    return {
      position: "fixed",
      zIndex: 1001,
      left: commentEditor.left,
      top: commentEditor.top,
      transform,
    };
  }, [commentEditor]);
  const editorContainerStyle = useMemo<CSSProperties | undefined>(() => {
    if (!commentEditorPositionStyle || !commentEditor) {
      return undefined;
    }
    let availableHeight = commentEditor.top - EDITOR_GUTTER;
    if (commentEditor.centered) {
      const viewport = getContentViewportBounds();
      availableHeight = viewport.bottom - viewport.top - EDITOR_GUTTER * 2;
    } else if (commentEditor.placeBelow) {
      availableHeight = getContentViewportBounds().bottom - commentEditor.top - EDITOR_GUTTER;
    }
    return {
      ...commentEditorPositionStyle,
      pointerEvents: "auto",
      width: `min(${commentEditor.attachmentId ? EDITOR_MAX_WIDTH : COMPACT_EDITOR_MAX_WIDTH}px, calc(100vw - ${EDITOR_GUTTER * 2}px))`,
      maxWidth: `calc(100vw - ${EDITOR_GUTTER * 2}px)`,
      maxHeight: Math.max(96, availableHeight),
      boxSizing: "border-box",
      overflow: "auto",
    };
  }, [commentEditor, commentEditorPositionStyle]);

  const editor =
    commentEditor && (onCommentSelection || onEditComment)
      ? createPortal(
          <div
            ref={editorElementRef}
            data-testid="assistant-selection-comment-editor"
            data-editor-mode={commentEditor.attachmentId ? "edit" : "create"}
            data-editor-placement={commentEditor.centered ? "centered" : "anchored"}
            onMouseDown={handleEditorMouseDown}
            style={editorContainerStyle}
          >
            {commentEditor.attachmentId ? (
              <View style={[styles.editor, isEditorFocused && styles.editorFocused]}>
                <View style={styles.editorHeader}>
                  <Text style={styles.editorTitle}>{addToConversationLabel}</Text>
                </View>
                <TextInput
                  testID="assistant-selection-comment-input"
                  autoFocus
                  multiline
                  value={commentEditor.comment}
                  onChangeText={handleCommentChange}
                  onFocus={handleEditorFocus}
                  onBlur={handleEditorBlur}
                  placeholder={commentPlaceholder}
                  style={styles.editorInput}
                />
                <View style={styles.editorFooter}>
                  <Pressable
                    testID="assistant-selection-comment-cancel"
                    accessibilityRole="button"
                    accessibilityLabel={cancelCommentLabel}
                    onPress={handleCancelComment}
                    style={styles.editorCancel}
                  >
                    <ThemedX size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
                    <Text style={styles.editorCancelText}>{cancelCommentLabel}</Text>
                  </Pressable>
                  <Pressable
                    testID="assistant-selection-comment-save"
                    accessibilityRole="button"
                    accessibilityLabel={saveCommentLabel}
                    onPress={handleSaveComment}
                    style={styles.editorSave}
                  >
                    <ThemedCheck size={ICON_SIZE.sm} uniProps={iconSaveMapping} />
                    <Text style={styles.editorSaveText}>{saveCommentLabel}</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={[styles.compactEditor, isEditorFocused && styles.compactEditorFocused]}>
                <TextInput
                  testID="assistant-selection-comment-input"
                  autoFocus
                  multiline
                  value={commentEditor.comment}
                  onChangeText={handleCommentChange}
                  onContentSizeChange={handleCompactContentSizeChange}
                  onFocus={handleEditorFocus}
                  onBlur={handleEditorBlur}
                  placeholder={commentPlaceholder}
                  style={[styles.compactEditorInput, { height: compactInputHeight }]}
                />
                <Button
                  testID="assistant-selection-comment-save"
                  accessibilityLabel={saveCommentLabel}
                  variant="secondary"
                  size="md"
                  leftIcon={ArrowUp}
                  onPress={handleSaveComment}
                  style={styles.compactEditorSave}
                />
              </View>
            )}
          </div>,
          getContentAdornmentRoot(),
        )
      : null;

  const selectionHighlight = renderSelectionHighlight(commentEditor, selectionHighlightRects);

  const annotationMarkerPortal =
    annotationMarkers.length > 0
      ? createPortal(
          <>
            {annotationMarkers.map((marker) => (
              <AnnotationMarkerButton
                key={marker.id}
                marker={marker}
                onOpenAnnotation={onOpenAnnotation}
              />
            ))}
          </>,
          getContentAdornmentRoot(),
        )
      : null;

  const selectionButton =
    selectionAction && onCommentSelection
      ? createPortal(
          <div onMouseDown={handleSelectionButtonMouseDown} style={selectionButtonPositionStyle}>
            <Pressable
              testID="assistant-selection-comment-button"
              accessibilityRole="button"
              accessibilityLabel={addToCommentLabel}
              onPress={handleOpenCommentEditor}
              style={styles.selectionButton}
            >
              <Text style={styles.selectionButtonText}>{addToCommentLabel}</Text>
            </Pressable>
          </div>,
          getContentAdornmentRoot(),
        )
      : null;

  return (
    <div
      onCopy={handleCopy}
      onPointerUp={visibleValue(visible, updateSelectionAction, undefined)}
      onKeyUp={visibleValue(visible, updateSelectionAction, undefined)}
      style={DISPLAY_CONTENTS}
    >
      <View style={style}>{children}</View>
      {visibleValue(visible, selectionHighlight, null)}
      {visibleValue(visible, annotationMarkerPortal, null)}
      {visibleValue(visible, selectionButton, null)}
      {visibleValue(visible, editor, null)}
    </div>
  );
}

function closeEditCommentEditor(current: CommentEditorState | null): CommentEditorState | null {
  return current?.attachmentId ? null : current;
}

function useKeepEditorInsideContentViewport(
  commentEditor: CommentEditorState | null,
  setCommentEditor: React.Dispatch<React.SetStateAction<CommentEditorState | null>>,
  editorElementRef: React.RefObject<HTMLDivElement | null>,
): void {
  useLayoutEffect(() => {
    if (!commentEditor || commentEditor.centered) return;
    const editor = editorElementRef.current;
    if (!editor || !isOutsideContentViewport(editor.getBoundingClientRect())) return;

    const maxWidth = commentEditor.attachmentId ? EDITOR_MAX_WIDTH : COMPACT_EDITOR_MAX_WIDTH;
    setCommentEditor((current) =>
      current && !current.centered
        ? { ...current, ...getCenteredEditorPosition(maxWidth) }
        : current,
    );
  }, [commentEditor, editorElementRef, setCommentEditor]);
}

function useDismissEditorOnOutsideInteraction(
  commentEditor: CommentEditorState | null,
  editorElementRef: React.RefObject<HTMLDivElement | null>,
  dismissCommentEditor: () => void,
): void {
  useEffect(() => {
    if (!commentEditor) return;
    const dismissForOutsideTarget = (event: Event) => {
      if (event.target instanceof Node && !editorElementRef.current?.contains(event.target)) {
        dismissCommentEditor();
      }
    };
    document.addEventListener("pointerdown", dismissForOutsideTarget, true);
    document.addEventListener("focusin", dismissForOutsideTarget, true);
    return () => {
      document.removeEventListener("pointerdown", dismissForOutsideTarget, true);
      document.removeEventListener("focusin", dismissForOutsideTarget, true);
    };
  }, [commentEditor, dismissCommentEditor, editorElementRef]);
}

function renderSelectionHighlight(
  commentEditor: CommentEditorState | null,
  rects: SelectionHighlightRect[],
): ReactNode {
  if (!commentEditor?.attachmentId || rects.length === 0) return null;
  return createPortal(
    <>
      {rects.map((rect) => (
        <div
          key={rect.key}
          data-testid="assistant-selection-annotation-highlight"
          style={rect.style}
        >
          <View style={styles.annotationHighlight} />
        </div>
      ))}
    </>,
    getContentAdornmentRoot(),
  );
}

function getEditorPosition(rect: DOMRect | null, maxWidth = EDITOR_MAX_WIDTH): EditorPosition {
  const viewportWidth = window.innerWidth;
  const contentViewport = getContentViewportBounds();
  const editorWidth = Math.min(maxWidth, Math.max(240, viewportWidth - EDITOR_GUTTER * 2));
  const anchorX = rect ? rect.left + rect.width / 2 : viewportWidth / 2;
  const left = Math.min(
    viewportWidth - EDITOR_GUTTER - editorWidth / 2,
    Math.max(EDITOR_GUTTER + editorWidth / 2, anchorX),
  );
  if (!rect) {
    return getCenteredEditorPosition(maxWidth);
  }

  const spaceAbove = rect.top - contentViewport.top - EDITOR_GUTTER - 12;
  const spaceBelow = contentViewport.bottom - rect.bottom - EDITOR_GUTTER - 12;
  if (
    rect.bottom <= contentViewport.top + EDITOR_GUTTER ||
    rect.top >= contentViewport.bottom - EDITOR_GUTTER ||
    Math.max(spaceAbove, spaceBelow) < EDITOR_MIN_WORKING_HEIGHT
  ) {
    return getCenteredEditorPosition(maxWidth);
  }
  const placeBelow = spaceBelow >= EDITOR_MIN_WORKING_HEIGHT || spaceBelow >= spaceAbove;
  if (placeBelow) {
    return { left, top: rect.bottom + 12, placeBelow: true, centered: false };
  }
  return { left, top: rect.top - 12, placeBelow: false, centered: false };
}

function getCenteredEditorPosition(maxWidth: number): EditorPosition {
  const viewportWidth = window.innerWidth;
  const editorWidth = Math.min(maxWidth, Math.max(240, viewportWidth - EDITOR_GUTTER * 2));
  const left = Math.min(
    viewportWidth - EDITOR_GUTTER - editorWidth / 2,
    Math.max(EDITOR_GUTTER + editorWidth / 2, viewportWidth / 2),
  );
  return {
    left,
    top: (getContentViewportBounds().top + getContentViewportBounds().bottom) / 2,
    placeBelow: true,
    centered: true,
  };
}

function getContentViewportBounds(): { top: number; bottom: number } {
  const chatRect = getVisibleChatScrollRect();
  return {
    top: Math.max(0, chatRect?.top ?? 0),
    bottom: Math.min(
      window.innerHeight,
      chatRect?.bottom ?? window.innerHeight,
      getVisibleComposerInputRect()?.top ?? window.innerHeight,
    ),
  };
}

function isOutsideContentViewport(rect: DOMRect): boolean {
  const viewport = getContentViewportBounds();
  return (
    rect.left < EDITOR_GUTTER ||
    rect.right > window.innerWidth - EDITOR_GUTTER ||
    rect.top < viewport.top + EDITOR_GUTTER ||
    rect.bottom > viewport.bottom - EDITOR_GUTTER
  );
}

function getSelectionButtonPosition(
  rect: DOMRect,
): Pick<SelectionAction, "buttonLeft" | "buttonTop"> {
  const buttonWidth = 116;
  const rightCandidate = rect.right + 8;
  const left =
    rightCandidate + buttonWidth <= window.innerWidth - EDITOR_GUTTER
      ? rightCandidate
      : Math.max(EDITOR_GUTTER, rect.left - buttonWidth - 8);
  return {
    buttonLeft: left,
    buttonTop: rect.top + rect.height / 2,
  };
}

function closestAssistantMessage(range: Range): Element | null {
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const end =
    range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const startMessage = start?.closest(ASSISTANT_MESSAGE_SELECTOR) ?? null;
  const endMessage = end?.closest(ASSISTANT_MESSAGE_SELECTOR) ?? null;
  return startMessage && startMessage === endMessage ? startMessage : null;
}

function getAssistantMessageId(message: Element): string | null {
  const item = message.closest<HTMLElement>(ASSISTANT_MESSAGE_ITEM_SELECTOR);
  const testId = item?.dataset.testid;
  const prefix = "assistant-message-item:";
  return testId?.startsWith(prefix) ? testId.slice(prefix.length) : null;
}

function findMessageForAnnotation(annotation: {
  text: string;
  sourceMessageId?: string;
  occurrence?: number;
}): Element | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_MESSAGE_ITEM_SELECTOR));
  if (annotation.sourceMessageId) {
    const source = items.find(
      (item) => item.dataset.testid === `assistant-message-item:${annotation.sourceMessageId}`,
    );
    if (source) {
      return source.querySelector(ASSISTANT_MESSAGE_SELECTOR);
    }
  }
  return (
    items
      .map((item) => item.querySelector(ASSISTANT_MESSAGE_SELECTOR))
      .find(
        (message) => message && findTextRange(message, annotation.text, annotation.occurrence),
      ) ?? null
  );
}

function findTextRange(root: Element, text: string, occurrence = 0): Range | null {
  const searchText = markdownSelectionText(text);
  if (!searchText) {
    return null;
  }
  const searchable = searchableTextNodes(root);
  const start = findTextOccurrenceStart(searchable.text, searchText, occurrence);
  if (start < 0) {
    return null;
  }
  const startPoint = searchable.points[start];
  const endPoint = searchable.points[start + searchText.length - 1];
  if (!startPoint || !endPoint) {
    return null;
  }
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset + 1);
  return range;
}

function getRangeTextOccurrence(root: Element, text: string, selectedRange: Range): number | null {
  const searchText = markdownSelectionText(text);
  if (!searchText) return null;
  const searchable = searchableTextNodes(root);
  const selectedStart = searchable.points.findIndex(
    (point) => selectedRange.comparePoint(point.node, point.offset) === 0,
  );
  if (selectedStart < 0) return null;

  let occurrence = 0;
  let start = findTextOccurrenceStart(searchable.text, searchText, occurrence);
  while (start >= 0) {
    if (selectedStart === start) return occurrence;
    occurrence += 1;
    start = findTextOccurrenceStart(searchable.text, searchText, occurrence);
  }
  return null;
}

function findTextOccurrenceStart(text: string, searchText: string, occurrence: number): number {
  let start = -1;
  let fromIndex = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(searchText, fromIndex);
    if (start < 0) return -1;
    fromIndex = start + 1;
  }
  return start;
}

interface TextPoint {
  node: Node;
  offset: number;
}

function markdownSelectionText(markdown: string): string {
  const container = document.createElement("div");
  container.innerHTML = markdownParser.render(markdown);
  return normalizeSearchText(container.textContent ?? "");
}

function normalizeSearchText(text: string): string {
  return text.replace(/\s/g, "");
}

function searchableTextNodes(root: Element): { text: string; points: TextPoint[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const points: TextPoint[] = [];
  let text = "";
  let node = walker.nextNode();
  while (node) {
    const isIgnored = node.parentElement?.closest(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`);
    if (!isIgnored) {
      const content = node.textContent ?? "";
      for (let offset = 0; offset < content.length; offset += 1) {
        const character = content[offset];
        if (character && !/\s/.test(character)) {
          text += character;
          points.push({ node, offset });
        }
      }
    }
    node = walker.nextNode();
  }
  return { text, points };
}

function getSelectionHighlightRects(range: Range): SelectionHighlightRect[] {
  const contentViewport = getRangeContentViewportRect(range);
  const contentTop = contentViewport?.top ?? 0;
  const contentBottom = contentViewport?.bottom ?? window.innerHeight;
  return getTextRangeClientRects(range)
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .flatMap((rect, index) => {
      const top = Math.max(contentTop, rect.top);
      const bottom = Math.min(contentBottom, rect.bottom);
      const height = bottom - top;
      if (height <= 0) return [];
      return [
        {
          key: `${index}:${rect.left}:${top}:${rect.width}:${height}`,
          style: {
            position: "fixed" as const,
            zIndex: 999,
            pointerEvents: "none" as const,
            height,
            left: rect.left,
            top,
            width: rect.width,
          },
        },
      ];
    });
}

function getRangeContentViewportRect(range: Range): DOMRect | null {
  return (
    closestAssistantMessage(range)?.closest(CHAT_SCROLL_SELECTOR)?.getBoundingClientRect() ?? null
  );
}

function getTextRangeClientRects(range: Range): DOMRect[] {
  const commonAncestor = range.commonAncestorContainer;
  const textNodes: Node[] = [];
  if (commonAncestor.nodeType === Node.TEXT_NODE) {
    textNodes.push(commonAncestor);
  } else {
    const walker = document.createTreeWalker(commonAncestor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) textNodes.push(node);
      node = walker.nextNode();
    }
  }

  return textNodes.flatMap((node) => {
    if (
      node.parentElement?.closest(`[${MARKDOWN_COPY_IGNORE_ATTRIBUTE}]`) ||
      !range.intersectsNode(node)
    ) {
      return [];
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : (node.textContent?.length ?? 0);
    if (start >= end) return [];

    const textRange = document.createRange();
    textRange.setStart(node, start);
    textRange.setEnd(node, end);
    return Array.from(textRange.getClientRects());
  });
}

function getAnnotationMarkers(
  annotations: readonly SelectedTextComposerAttachment[],
): AnnotationMarker[] {
  const markerWidth = 26;
  const markerHeight = 28;
  const viewportGutter = 8;
  const composerRect = getVisibleComposerInputRect();
  return annotations.flatMap((annotation, index) => {
    const message = findMessageForAnnotation(annotation);
    const range = message ? findTextRange(message, annotation.text, annotation.occurrence) : null;
    const rects = range ? Array.from(range.getClientRects()) : [];
    const anchor = rects.at(-1);
    const contentViewport = message?.closest(CHAT_SCROLL_SELECTOR)?.getBoundingClientRect() ?? null;
    const contentTop = contentViewport?.top ?? 0;
    const unclampedTop = anchor ? anchor.top - markerHeight + 6 : 0;
    if (
      !anchor ||
      anchor.width <= 0 ||
      anchor.height <= 0 ||
      anchor.bottom < 0 ||
      anchor.top > window.innerHeight ||
      (contentViewport && unclampedTop < contentTop + viewportGutter)
    ) {
      return [];
    }
    const left = Math.min(
      window.innerWidth - viewportGutter - markerWidth,
      Math.max(viewportGutter, anchor.right - markerWidth / 2),
    );
    const top = Math.min(
      window.innerHeight - viewportGutter - markerHeight,
      Math.max(contentViewport ? contentTop + viewportGutter : viewportGutter, unclampedTop),
    );
    if (composerRect && rectanglesIntersect(left, top, markerWidth, markerHeight, composerRect)) {
      return [];
    }
    return [
      {
        annotation,
        id: annotation.id,
        left,
        number: index + 1,
        top,
        style: {
          position: "fixed",
          zIndex: ANNOTATION_MARKER_Z_INDEX,
          pointerEvents: "auto",
          height: markerHeight,
          left,
          top,
          width: markerWidth,
        },
      },
    ];
  });
}

function getVisibleComposerInputRect(): DOMRect | null {
  for (const element of document.querySelectorAll(COMPOSER_INPUT_AREA_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
      return rect;
    }
  }
  return null;
}

function getVisibleChatScrollRect(): DOMRect | null {
  for (const element of document.querySelectorAll(CHAT_SCROLL_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
      return rect;
    }
  }
  return null;
}

function rectanglesIntersect(
  left: number,
  top: number,
  width: number,
  height: number,
  obstacle: DOMRect,
): boolean {
  return (
    left < obstacle.right &&
    left + width > obstacle.left &&
    top < obstacle.bottom &&
    top + height > obstacle.top
  );
}

function AnnotationMarkerButton({
  marker,
  onOpenAnnotation,
}: {
  marker: AnnotationMarker;
  onOpenAnnotation?: (annotation: SelectedTextComposerAttachment) => void;
}) {
  const handlePress = useCallback(
    () => onOpenAnnotation?.(marker.annotation),
    [marker.annotation, onOpenAnnotation],
  );
  return (
    <div style={marker.style}>
      <Pressable
        testID={`assistant-selection-annotation-marker-${marker.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${marker.number}`}
        disabled={!onOpenAnnotation}
        onPress={handlePress}
        style={annotationMarkerButtonStyle}
      >
        <ThemedAnnotationMarkerShape uniProps={annotationMarkerShapeMapping} />
        <Text style={styles.annotationMarkerText}>{marker.number}</Text>
      </Pressable>
    </div>
  );
}

function AnnotationMarkerShape({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <Svg width={26} height={28} viewBox="0 0 26 28" style={styles.annotationMarkerShape}>
      <Path
        d="M13 1.25c6.49 0 11.75 5.09 11.75 11.37S19.49 24 13 24c-1.21 0-2.38-.18-3.48-.51L4.4 26.65l1.43-4.72c-2.79-2.08-4.58-5.44-4.58-9.31C1.25 6.34 6.51 1.25 13 1.25Z"
        fill={fill}
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function annotationMarkersEqual(left: AnnotationMarker[], right: AnnotationMarker[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (marker, index) =>
        marker.id === right[index]?.id &&
        marker.annotation === right[index]?.annotation &&
        marker.number === right[index]?.number &&
        marker.left === right[index]?.left &&
        marker.top === right[index]?.top,
    )
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  selectionButton: {
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.24)",
  },
  selectionButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  annotationHighlight: {
    width: "100%",
    height: "100%",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.palette.blue[500],
    opacity: theme.opacity[50],
  },
  annotationMarkerButton: {
    position: "relative",
    width: 26,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    filter: "drop-shadow(0 2px 4px rgba(0, 0, 0, 0.28))",
  },
  annotationMarkerPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.94 }],
  },
  annotationMarkerShape: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  annotationMarkerText: {
    position: "absolute",
    top: 4,
    left: 0,
    width: 26,
    lineHeight: 16,
    textAlign: "center",
    color: theme.colors.palette.white,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  compactEditor: {
    position: "relative",
    width: "100%",
    minHeight: 52,
    padding: theme.spacing[1],
    paddingLeft: theme.spacing[4],
    borderRadius: theme.borderRadius["3xl"],
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.32)",
  },
  compactEditorFocused: {
    borderColor: theme.colors.borderAccent,
  },
  compactEditorInput: {
    width: "100%",
    minWidth: 0,
    minHeight: COMPACT_EDITOR_MIN_INPUT_HEIGHT,
    maxHeight: COMPACT_EDITOR_MAX_INPUT_HEIGHT,
    backgroundColor: "transparent",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    paddingLeft: 0,
    paddingRight: theme.spacing[12],
    paddingVertical: theme.spacing[2],
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  compactEditorSave: {
    position: "absolute",
    right: theme.spacing[1],
    bottom: theme.spacing[1],
    width: 44,
    height: 44,
    paddingHorizontal: theme.spacing[0],
    borderRadius: theme.borderRadius.full,
  },
  editor: {
    width: "100%",
    maxHeight: 300,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.32)",
  },
  editorFocused: {
    borderColor: theme.colors.borderAccent,
  },
  editorHeader: {
    marginBottom: theme.spacing[2],
  },
  editorTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  editorInput: {
    minHeight: 70,
    maxHeight: 140,
    backgroundColor: "transparent",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    padding: 0,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  editorFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  editorCancel: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  editorCancelText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  editorSave: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
  },
  editorSaveText: {
    color: theme.colors.background,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
