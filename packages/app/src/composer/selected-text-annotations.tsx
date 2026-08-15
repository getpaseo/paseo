import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MessageSquare, X } from "lucide-react-native";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SelectedTextComposerAttachment } from "@/attachments/types";
import { getSelectedTextPreview } from "@/attachments/selected-text";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "@/components/ui/floating-panel-portal";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SelectedTextAnnotationsPortal } from "./selected-text-annotations-portal";
import { useSelectedTextAnnotationsDismiss } from "./use-selected-text-annotations-dismiss";

interface SelectedTextAnnotationsLabels {
  count: string;
  remove: string;
  noComment: string;
}

interface SelectedTextAnnotationsProps {
  annotations: SelectedTextComposerAttachment[];
  disabled: boolean;
  isPaneFocused: boolean;
  labels: SelectedTextAnnotationsLabels;
  onOpen: (annotation: SelectedTextComposerAttachment) => void;
  onRemove: (id: string) => void;
}

const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const DETAILS_GUTTER = 8;
const DETAILS_MAX_WIDTH = 380;

interface AnnotationDetailsPosition {
  hostBottom: number;
  hostLeft: number;
  hostMaxHeight: number;
  windowBottom: number;
  windowLeft: number;
  windowMaxHeight: number;
  width: number;
}

function measureElement(element: View): Promise<{ x: number; y: number; width: number }> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width) => resolve({ x, y, width }));
  });
}

export function SelectedTextAnnotations({
  annotations,
  disabled,
  isPaneFocused,
  labels,
  onOpen,
  onRemove,
}: SelectedTextAnnotationsProps) {
  const [isPinnedOpen, setIsPinnedOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isHoverSuppressed, setIsHoverSuppressed] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<AnnotationDetailsPosition | null>(null);
  const anchorRef = useRef<View>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portalHostName = useFloatingPanelPortalHostName();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const showDetails = isPaneFocused && (isPinnedOpen || (isHovered && !isHoverSuppressed));
  const handlePointerEnter = useCallback(() => {
    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    setIsHovered(true);
  }, []);
  const handlePointerLeave = useCallback(() => {
    if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    hoverLeaveTimerRef.current = setTimeout(() => setIsHovered(false), 80);
  }, []);
  const handleToggle = useCallback(() => {
    if (showDetails) {
      setIsPinnedOpen(false);
      setIsHoverSuppressed(true);
      return;
    }
    setIsPinnedOpen(true);
    setIsHoverSuppressed(false);
  }, [showDetails]);
  const dismissDetails = useCallback(() => {
    setIsPinnedOpen(false);
    setIsHovered(false);
    setIsHoverSuppressed(true);
  }, []);
  useSelectedTextAnnotationsDismiss({ visible: showDetails, onDismiss: dismissDetails });
  const handleOpenAnnotation = useCallback(
    (annotation: SelectedTextComposerAttachment) => {
      setIsPinnedOpen(false);
      setIsHoverSuppressed(true);
      onOpen(annotation);
    },
    [onOpen],
  );
  const triggerStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.trigger, pressed && styles.triggerPressed],
    [],
  );

  useEffect(() => {
    if (!showDetails) {
      setDetailsPosition(null);
      return;
    }
    let cancelled = false;
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      void Promise.all([
        measureElement(anchor),
        measureFloatingPanelPortalHost(portalHostName),
      ]).then(([anchorRect, hostRect]) => {
        if (cancelled || !hostRect) return undefined;
        const width = Math.min(DETAILS_MAX_WIDTH, hostRect.width - DETAILS_GUTTER * 2);
        const anchorLeft = anchorRect.x - hostRect.x;
        const hostLeft = Math.max(
          DETAILS_GUTTER,
          Math.min(anchorLeft, hostRect.width - width - DETAILS_GUTTER),
        );
        setDetailsPosition({
          hostBottom: hostRect.height - (anchorRect.y - hostRect.y) + DETAILS_GUTTER,
          hostLeft,
          hostMaxHeight: Math.max(0, anchorRect.y - hostRect.y - DETAILS_GUTTER * 2),
          windowBottom: windowHeight - anchorRect.y + DETAILS_GUTTER,
          windowLeft: hostRect.x + hostLeft,
          windowMaxHeight: Math.max(0, anchorRect.y - DETAILS_GUTTER * 2),
          width,
        });
        return undefined;
      });
    };
    measure();
    const frame = requestAnimationFrame(measure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [annotations.length, portalHostName, showDetails, windowHeight, windowWidth]);

  useEffect(
    () => () => {
      if (hoverLeaveTimerRef.current) clearTimeout(hoverLeaveTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isPaneFocused) dismissDetails();
  }, [dismissDetails, isPaneFocused]);

  const floatingDetailsStyle = useMemo(
    () =>
      detailsPosition
        ? inlineUnistylesStyle({
            position: "absolute" as const,
            bottom: detailsPosition.hostBottom,
            left: detailsPosition.hostLeft,
            maxHeight: detailsPosition.hostMaxHeight,
            width: detailsPosition.width,
          })
        : null,
    [detailsPosition],
  );
  const webFloatingDetailsStyle = useMemo(
    () =>
      detailsPosition
        ? inlineUnistylesStyle({
            position: "fixed" as const,
            zIndex: 1002,
            bottom: detailsPosition.windowBottom,
            left: detailsPosition.windowLeft,
            maxHeight: detailsPosition.windowMaxHeight,
            width: detailsPosition.width,
          })
        : null,
    [detailsPosition],
  );

  return (
    <View
      ref={anchorRef}
      style={styles.root}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="composer-selected-text-annotations"
    >
      <Pressable
        testID="composer-selected-text-annotations-trigger"
        accessibilityRole="button"
        accessibilityLabel={labels.count}
        disabled={disabled}
        onPress={handleToggle}
        style={triggerStyle}
      >
        <ThemedMessageSquare size={ICON_SIZE.sm} uniProps={iconMutedMapping} />
        <Text style={styles.triggerText}>{labels.count}</Text>
        <ThemedChevronDown size={ICON_SIZE.sm} uniProps={iconMutedMapping} />
      </Pressable>
      {showDetails && floatingDetailsStyle && webFloatingDetailsStyle ? (
        <SelectedTextAnnotationsPortal
          hostName={portalHostName}
          hostStyle={[styles.details, floatingDetailsStyle]}
          webStyle={[styles.details, webFloatingDetailsStyle]}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <ScrollView
            testID="composer-selected-text-annotations-list"
            style={styles.detailsScroll}
            showsVerticalScrollIndicator
          >
            {annotations.map((annotation, index) => (
              <AnnotationRow
                key={annotation.id}
                annotation={annotation}
                index={index}
                disabled={disabled}
                noCommentLabel={labels.noComment}
                removeLabel={labels.remove}
                onOpen={handleOpenAnnotation}
                onRemove={onRemove}
              />
            ))}
          </ScrollView>
        </SelectedTextAnnotationsPortal>
      ) : null}
    </View>
  );
}

function AnnotationRow({
  annotation,
  index,
  disabled,
  noCommentLabel,
  removeLabel,
  onOpen,
  onRemove,
}: {
  annotation: SelectedTextComposerAttachment;
  index: number;
  disabled: boolean;
  noCommentLabel: string;
  removeLabel: string;
  onOpen: (annotation: SelectedTextComposerAttachment) => void;
  onRemove: (id: string) => void;
}) {
  const handleOpen = useCallback(() => onOpen(annotation), [annotation, onOpen]);
  const handleRemove = useCallback(() => onRemove(annotation.id), [annotation.id, onRemove]);
  const annotationMainStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.annotationMain,
      pressed && styles.annotationPressed,
    ],
    [],
  );
  const preview = getSelectedTextPreview(annotation.text);
  const comment = annotation.comment?.trim();

  return (
    <View style={[styles.annotationRow, index > 0 && styles.annotationRowBorder]}>
      <Pressable
        testID={`composer-selected-text-annotation-${annotation.id}`}
        accessibilityRole="button"
        accessibilityLabel={preview}
        disabled={disabled}
        onPress={handleOpen}
        style={annotationMainStyle}
      >
        <View style={styles.annotationIndex}>
          <Text style={styles.annotationIndexText}>{index + 1}</Text>
        </View>
        <View style={styles.annotationCopy}>
          <Text style={styles.annotationSelection} numberOfLines={2}>
            {preview}
          </Text>
          <Text
            style={comment ? styles.annotationComment : styles.annotationNoComment}
            numberOfLines={2}
          >
            {comment || noCommentLabel}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={removeLabel}
        disabled={disabled}
        onPress={handleRemove}
        hitSlop={6}
        style={styles.annotationRemove}
      >
        <ThemedX size={ICON_SIZE.sm} uniProps={iconForegroundMapping} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: {
    position: "relative",
    zIndex: 10,
  },
  trigger: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  triggerPressed: {
    opacity: 0.82,
  },
  triggerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  details: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.3)",
  },
  detailsScroll: {
    flexShrink: 1,
  },
  annotationRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  annotationRowBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  annotationMain: {
    minWidth: 0,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  annotationPressed: {
    backgroundColor: theme.colors.surface3,
  },
  annotationIndex: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  annotationIndexText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  annotationCopy: {
    minWidth: 0,
    flex: 1,
    gap: theme.spacing[1],
  },
  annotationSelection: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  annotationComment: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  annotationNoComment: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  annotationRemove: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
}));
