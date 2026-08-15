import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { BrowserElementAttachment } from "@/attachments/types";
import {
  getOverlayRoot,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { X } from "lucide-react-native";

export type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
};

export interface BrowserElementAnnotation {
  comment: string;
}

interface BrowserPaneOverlayFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface BrowserElementAnnotationCardProps {
  clipRef: RefObject<HTMLElement | null>;
  selection: BrowserElementSelection;
  onSubmit: (annotation: BrowserElementAnnotation) => void;
  onCancel: () => void;
}

function readBrowserPaneOverlayFrame(element: HTMLElement | null): BrowserPaneOverlayFrame | null {
  if (!element) {
    return null;
  }
  const { left, top, width, height } = element.getBoundingClientRect();
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height };
}

function areOverlayFramesEqual(
  previous: BrowserPaneOverlayFrame | null,
  next: BrowserPaneOverlayFrame | null,
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return false;
  }
  return (
    previous.left === next.left &&
    previous.top === next.top &&
    previous.width === next.width &&
    previous.height === next.height
  );
}

function getElementLabel(selection: BrowserElementSelection): string {
  const text = selection.text.trim().replace(/\s+/g, " ");
  const preview = text.length > 60 ? `${text.slice(0, 60).trim()}...` : text;
  return preview ? `${selection.tag} · ${preview}` : selection.tag;
}

function useBrowserPaneOverlayFrame(
  clipRef: RefObject<HTMLElement | null>,
): BrowserPaneOverlayFrame | null {
  const [frame, setFrame] = useState<BrowserPaneOverlayFrame | null>(null);
  const frameRef = useRef<BrowserPaneOverlayFrame | null>(null);

  useLayoutEffect(() => {
    let animationFrame: number | null = null;

    const updateFrame = () => {
      const nextFrame = readBrowserPaneOverlayFrame(clipRef.current);
      if (areOverlayFramesEqual(frameRef.current, nextFrame)) {
        return;
      }
      frameRef.current = nextFrame;
      setFrame(nextFrame);
    };
    const scheduleFrame = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        updateFrame();
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleFrame);
    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };

    updateFrame();
    scheduleFrame();

    const clip = clipRef.current;
    if (clip) {
      resizeObserver?.observe(clip);
    }
    window.addEventListener("resize", scheduleFrame);
    window.addEventListener("scroll", scheduleFrame, scrollOptions);

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleFrame);
      window.removeEventListener("scroll", scheduleFrame, scrollOptions);
    };
  }, [clipRef]);

  return frame;
}

export function BrowserElementAnnotationCard({
  clipRef,
  selection,
  onSubmit,
  onCancel,
}: BrowserElementAnnotationCardProps) {
  const { t } = useTranslation();
  const [comment, setComment] = useState("");
  const commentRef = useRef(comment);
  commentRef.current = comment;
  const overlayFrame = useBrowserPaneOverlayFrame(clipRef);
  const overlayLayer = useGlobalWebOverlayLayer("modal", overlayFrame !== null);

  const handleSubmit = useCallback(() => {
    onSubmit({ comment: commentRef.current });
  }, [onSubmit]);

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return true;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        handleSubmit();
        return true;
      }
      return false;
    },
    [handleSubmit, onCancel],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: overlayFrame !== null,
    layer: overlayLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const elementLabel = getElementLabel(selection);

  if (!overlayFrame) {
    return null;
  }

  return createPortal(
    <View
      pointerEvents="none"
      style={[styles.annotationOverlay, overlayFrame, { zIndex: overlayLayer }]}
    >
      <View
        ref={setWebOverlayScope}
        pointerEvents="auto"
        role="dialog"
        aria-modal
        tabIndex={-1}
        style={styles.annotationCard}
        testID="browser-element-annotation-card"
      >
        <View style={styles.annotationHeader}>
          <Text numberOfLines={1} style={styles.annotationTitle}>
            {t("workspace.browser.annotate.title")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspace.browser.annotate.cancel")}
            onPress={onCancel}
            style={styles.annotationCloseButton}
          >
            <ThemedCloseIcon size={16} uniProps={iconForegroundMutedMapping} />
          </Pressable>
        </View>
        <Text numberOfLines={1} style={styles.annotationElement}>
          {elementLabel}
        </Text>
        <ThemedAnnotationInput
          accessibilityLabel={t("workspace.browser.annotate.placeholder")}
          autoFocus
          multiline
          onChangeText={setComment}
          placeholder={t("workspace.browser.annotate.placeholder")}
          style={styles.annotationInput}
          uniProps={annotationInputMapping}
          value={comment}
        />
        <View style={styles.annotationActions}>
          <Button variant="ghost" size="sm" onPress={onCancel}>
            {t("workspace.browser.annotate.cancel")}
          </Button>
          <Button variant="default" size="sm" onPress={handleSubmit}>
            {t("workspace.browser.annotate.submit")}
          </Button>
        </View>
      </View>
    </View>,
    getOverlayRoot(),
  );
}

const ThemedCloseIcon = withUnistyles(X);
const ThemedAnnotationInput = withUnistyles(TextInput);
const iconForegroundMutedMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const annotationInputMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create((theme) => ({
  annotationOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    padding: theme.spacing[3],
    alignItems: "center",
    justifyContent: "flex-end",
  },
  annotationCard: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  annotationHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  annotationTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  annotationCloseButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  annotationElement: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[2],
  },
  annotationInput: {
    minHeight: 64,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    textAlignVertical: "top",
  },
  annotationActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
