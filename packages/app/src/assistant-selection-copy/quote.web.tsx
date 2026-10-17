import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Dimensions,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { createPortal } from "react-dom";
import { FadeIn } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { TextQuote } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { computePosition, type Alignment, type Rect, type Size } from "@/components/ui/anchor";
import { Button } from "@/components/ui/button";
import { FloatingSurface, type FloatingSurfaceProps } from "@/components/ui/floating";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { createAssistantSelectionMarkdown } from "./content.web";
import type { ComposerQuote } from "./composer-quote";

type QuoteState = { phase: "idle" } | { phase: "offered" | "noting"; range: Range; quote: string };

const IDLE: QuoteState = { phase: "idle" };
const ANCHOR_OFFSET = 4;
const FADE_IN = FadeIn.duration(80);

/**
 * Quote for a selection inside one agent message: a Quote button at the end of the
 * selection opens a note box, and Enter puts the quote and the note into the composer.
 *
 * The quote is read when the selection settles, so a message that keeps streaming, or
 * a selection the note box takes over, still quotes what was selected.
 */
export function AssistantSelectionQuote({
  streamRef,
  onQuote,
}: {
  /** The agent's message stream; a selection anywhere else is not this quote's. */
  streamRef: RefObject<HTMLElement | null>;
  onQuote: (quote: ComposerQuote) => void;
}) {
  const [state, setState] = useState<QuoteState>(IDLE);
  const stateRef = useRef(state);
  const floatingRef = useRef<HTMLElement | null>(null);
  const update = useCallback((next: QuoteState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    let pointerDown = false;
    let frame = 0;

    const readSelection = () => {
      frame = 0;
      if (stateRef.current.phase === "noting") return;
      const selection = window.getSelection();
      const range =
        selection && selection.rangeCount === 1 && !selection.isCollapsed
          ? selection.getRangeAt(0)
          : null;
      const quote =
        range && streamRef.current?.contains(range.commonAncestorContainer)
          ? createAssistantSelectionMarkdown(selection)
          : null;
      update(range && quote ? { phase: "offered", range: range.cloneRange(), quote } : IDLE);
    };
    const scheduleRead = () => {
      if (!frame) frame = window.requestAnimationFrame(readSelection);
    };
    const handleSelectionChange = () => {
      // A drag settles on pointerup; until then the button would chase the pointer.
      if (!pointerDown) scheduleRead();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (floatingRef.current?.contains(event.target as Node)) return;
      pointerDown = true;
      update(IDLE);
    };
    const handlePointerUp = () => {
      if (!pointerDown) return;
      pointerDown = false;
      scheduleRead();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
    };
  }, [streamRef, update]);

  const dismiss = useCallback(() => update(IDLE), [update]);
  const openNote = useCallback(() => {
    const current = stateRef.current;
    if (current.phase === "offered") update({ ...current, phase: "noting" });
  }, [update]);
  const submitNote = useCallback(
    (note: string) => {
      const current = stateRef.current;
      if (current.phase !== "noting") return;
      onQuote({ quote: current.quote, note });
      update(IDLE);
    },
    [onQuote, update],
  );
  const cancelNote = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== "noting") return;
    update(IDLE);
    // Escape hands the passage back as it was, so it can be copied or quoted again.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(current.range);
  }, [update]);

  if (state.phase === "offered") {
    return (
      <QuoteButton
        range={state.range}
        floatingRef={floatingRef}
        onPress={openNote}
        onDismiss={dismiss}
      />
    );
  }
  if (state.phase === "noting") {
    return (
      <QuoteNoteBox
        range={state.range}
        floatingRef={floatingRef}
        onSubmit={submitNote}
        onCancel={cancelNote}
      />
    );
  }
  return null;
}

function QuoteButton({
  range,
  floatingRef,
  onPress,
  onDismiss,
}: {
  range: Range;
  floatingRef: RefObject<HTMLElement | null>;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      onDismiss();
      return true;
    },
    [onDismiss],
  );
  const setOverlayScope = useWebOverlayRegistration({
    active: true,
    layer,
    onKeyDown: handleKeyDown,
    manageFocus: false,
    passive: true,
  });
  const setSurface = useCallback(
    (node: View | null) => {
      const element = node instanceof HTMLElement ? node : null;
      // Pressing must not move focus or collapse the selection it quotes.
      floatingRef.current?.removeEventListener("mousedown", preventDefault);
      element?.addEventListener("mousedown", preventDefault);
      floatingRef.current = element;
      setOverlayScope(element);
    },
    [floatingRef, setOverlayScope],
  );

  return (
    <AnchoredSurface
      range={range}
      alignment="end"
      layer={layer}
      entering={FADE_IN}
      surfaceRef={setSurface}
      testID="assistant-selection-quote"
    >
      <Button
        variant="ghost"
        size="xs"
        leftIcon={TextQuote}
        onPress={onPress}
        testID="assistant-selection-quote-button"
      >
        {t("agentStream.quote.action")}
      </Button>
    </AnchoredSurface>
  );
}

function QuoteNoteBox({
  range,
  floatingRef,
  onSubmit,
  onCancel,
}: {
  range: Range;
  floatingRef: RefObject<HTMLElement | null>;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer("floating");
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const noteRef = useRef("");
  const handleChangeText = useCallback((text: string) => {
    noteRef.current = text;
  }, []);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const input = inputRef.current?.getNativeRef();
      if (event.key === "Escape") {
        event.preventDefault();
        // Let go of focus first, so the passage can be selected again behind the box.
        if (input instanceof HTMLElement) input.blur();
        onCancel();
        return true;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        event.target === input &&
        !isImeComposingKeyboardEvent(event)
      ) {
        event.preventDefault();
        onSubmit(noteRef.current);
        return true;
      }
      return false;
    },
    [onCancel, onSubmit],
  );
  // The box takes focus itself: the registry would hand focus back to the page when it
  // closes, and Enter moves it to the composer.
  const setOverlayScope = useWebOverlayRegistration({
    active: true,
    layer,
    onKeyDown: handleKeyDown,
    manageFocus: false,
  });
  const setSurface = useCallback(
    (node: View | null) => {
      const element = node instanceof HTMLElement ? node : null;
      floatingRef.current = element;
      setOverlayScope(element);
    },
    [floatingRef, setOverlayScope],
  );

  useEffect(() => {
    const element = inputRef.current?.getNativeRef();
    if (!(element instanceof HTMLElement)) return;
    // The box mounts off-screen until it is measured; scrolling to it would move the chat.
    element.focus({ preventScroll: true });
  }, []);

  // No fade-in: Reanimated hides an entering view until its animation starts, and a
  // hidden input cannot take focus.
  return (
    <AnchoredSurface
      range={range}
      alignment="start"
      layer={layer}
      style={styles.noteSurface}
      surfaceRef={setSurface}
      testID="assistant-selection-quote-note"
    >
      <EditingTextInput
        ref={inputRef}
        multiline
        accessibilityLabel={t("agentStream.quote.noteLabel")}
        placeholder={t("agentStream.quote.notePlaceholder")}
        placeholderTextColor={styles.placeholder.color}
        onChangeText={handleChangeText}
        style={styles.noteInput}
        testID="assistant-selection-quote-note-input"
      />
      <Text style={styles.hint}>{t("agentStream.quote.hint")}</Text>
    </AnchoredSurface>
  );
}

function AnchoredSurface({
  range,
  alignment,
  layer,
  entering,
  style,
  surfaceRef,
  testID,
  children,
}: {
  range: Range;
  alignment: Alignment;
  layer: number;
  entering?: FloatingSurfaceProps["entering"];
  style?: StyleProp<ViewStyle>;
  /** The whole floating surface, padding included, so a press on its rim stays inside. */
  surfaceRef: (node: View | null) => void;
  testID: string;
  children: ReactNode;
}) {
  const anchor = useRangeEndRect(range);
  const [size, setSize] = useState<Size | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);
  const frameStyle = useMemo(() => {
    if (!anchor || !size) return { position: "absolute" as const, top: -9999, left: -9999 };
    const { width, height } = Dimensions.get("window");
    const { x, y } = computePosition({
      triggerRect: anchor,
      contentSize: size,
      displayArea: { x: 0, y: 0, width, height },
      placement: "bottom",
      alignment,
      offset: ANCHOR_OFFSET,
    });
    return { position: "absolute" as const, top: y, left: x };
  }, [alignment, anchor, size]);
  const surfaceStyle = useMemo(() => [styles.surface, style], [style]);
  const overlayStyle = useMemo(() => [styles.portalOverlay, { zIndex: layer }], [layer]);

  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <View pointerEvents="box-none" style={overlayStyle}>
        <FloatingSurface
          ref={surfaceRef}
          entering={entering}
          collapsable={false}
          onLayout={handleLayout}
          testID={testID}
          style={surfaceStyle}
          frameStyle={frameStyle}
        >
          {children}
        </FloatingSurface>
      </View>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}

/**
 * The last line box of the range, followed through scrolling. A range whose text the
 * stream re-rendered away has no box left, so the surface stays where it last was.
 */
function useRangeEndRect(range: Range): Rect | null {
  const [rect, setRect] = useState<Rect | null>(() => rangeEndRect(range));
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = rangeEndRect(range);
      if (next) setRect(next);
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    document.addEventListener("scroll", scheduleMeasure, true);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scheduleMeasure, true);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [range]);
  return rect;
}

function rangeEndRect(range: Range): Rect | null {
  const last = Array.from(range.getClientRects()).findLast((box) => box.width > 0);
  return last ? { x: last.left, y: last.top, width: last.width, height: last.height } : null;
}

function preventDefault(event: Event) {
  event.preventDefault();
}

const styles = StyleSheet.create((theme) => ({
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  surface: {
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    ...theme.shadow.md,
  },
  noteSurface: {
    width: 320,
    padding: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  noteInput: {
    height: theme.fontSize.content * 1.4 * 3 + theme.spacing[2] * 2,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.4,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
