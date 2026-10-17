import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Dimensions, View, type Role, type StyleProp, type ViewStyle } from "react-native";
import { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { Portal } from "@gorhom/portal";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import {
  OverlayLayerProvider,
  useOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { FloatingSurface } from "@/components/ui/floating";
import { isWeb } from "@/constants/platform";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";
import {
  computePosition,
  measureElement,
  type Alignment,
  type Placement,
  type Rect,
  type Size,
} from "./anchor";

const CLOSE_GRACE_MS = 100;

interface HoverCardContextValue {
  open: boolean;
  layer: number;
  setTriggerRef: (node: View | null) => void;
  triggerRef: RefObject<View | null>;
  contentRef: RefObject<View | null>;
  openNow: () => void;
  scheduleClose: () => void;
}

const HoverCardContext = createContext<HoverCardContextValue | null>(null);

/**
 * A card that opens while the pointer is on its trigger and stays open while the pointer crosses
 * onto it, so its content can be pressed. Hover only exists on web; elsewhere the trigger renders
 * alone and the content never mounts. See docs/hover.md.
 *
 * ```tsx
 * <HoverCard>
 *   <HoverCardTrigger>{trigger}</HoverCardTrigger>
 *   <HoverCardContent placement="top">{details}</HoverCardContent>
 * </HoverCard>
 * ```
 */
export function HoverCard({
  disabled = false,
  children,
}: {
  /** Closes the card and keeps it closed, e.g. while its trigger is dragged. */
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  if (!isWeb) return children;
  return <WebHoverCard disabled={disabled}>{children}</WebHoverCard>;
}

function WebHoverCard({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}): ReactElement {
  const layer = useOverlayLayer("floating");
  const triggerRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read when focus arrives: by focusout the element losing focus no longer matches :focus-visible.
  const keyboardFocusedRef = useRef(false);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const focusInside = useCallback(() => {
    if (!isWeb) return false;
    const active = document.activeElement;
    return [triggerRef.current, contentRef.current].some((view) =>
      (view as unknown as HTMLElement | null)?.contains(active),
    );
  }, []);

  // Keyboard focus keeps the card open for keyboard users; the focus a pointer click leaves
  // behind on the trigger or a button in the card does not outlast the pointer leaving.
  const keyboardFocusInside = useCallback(() => {
    return focusInside() && document.activeElement?.matches(":focus-visible") === true;
  }, [focusInside]);

  const scheduleClose = useCallback(() => {
    if (keyboardFocusInside()) return;
    if (graceTimerRef.current) return;
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      if (keyboardFocusInside()) return;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, [keyboardFocusInside]);

  const openNow = useCallback(() => {
    clearGraceTimer();
    if (!disabled) {
      setOpen(true);
    }
  }, [clearGraceTimer, disabled]);

  const keyPressed = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!isWeb) return false;
      const trigger = triggerRef.current as unknown as HTMLElement | null;
      if (!trigger) return false;
      if (event.key === "Escape" && open) {
        event.preventDefault();
        if (focusInside()) trigger.focus();
        clearGraceTimer();
        setOpen(false);
        return true;
      } else if (
        focusInside() &&
        event.target === trigger &&
        ["ArrowDown", "Enter", " "].includes(event.key)
      ) {
        event.preventDefault();
        openNow();
        requestAnimationFrame(() => {
          (contentRef.current as unknown as HTMLElement | null)
            ?.querySelector<HTMLElement>(
              'button, [role="button"][tabindex="0"], a[href], input, [tabindex="0"]',
            )
            ?.focus();
        });
        return true;
      }
      return false;
    },
    [clearGraceTimer, focusInside, open, openNow],
  );

  const setOverlayScope = useWebOverlayRegistration({
    active: !disabled && open,
    layer,
    onKeyDown: keyPressed,
    manageFocus: false,
  });
  const setTriggerRef = useCallback(
    (node: View | null) => {
      triggerRef.current = node;
      setOverlayScope(node);
    },
    [setOverlayScope],
  );

  useEffect(() => {
    if (!isWeb) return;
    const trigger = triggerRef.current as unknown as HTMLElement | null;
    if (!trigger) return;
    const close = () => {
      clearGraceTimer();
      setOpen(false);
    };
    const focusEntered = (event: FocusEvent) => {
      const target = event.target as Element;
      keyboardFocusedRef.current = target.matches(":focus-visible");
      if (trigger.contains(target)) {
        openNow();
      } else if ((contentRef.current as unknown as HTMLElement | null)?.contains(target)) {
        clearGraceTimer();
      }
    };
    // Only keyboard focus keeps the card open, so only losing keyboard focus closes it. A button
    // that disables itself on press drops pointer focus while the pointer is still on the card.
    const focusLeft = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (
        keyboardFocusedRef.current &&
        !trigger.contains(next) &&
        !(contentRef.current as unknown as HTMLElement | null)?.contains(next)
      ) {
        scheduleClose();
      }
    };
    const activateClosedTrigger = (event: KeyboardEvent) => {
      if (
        !open &&
        !event.defaultPrevented &&
        !event.isComposing &&
        ["ArrowDown", "Enter", " "].includes(event.key)
      )
        keyPressed(event);
    };
    const scrolled = (event: Event) => {
      if (!(contentRef.current as unknown as HTMLElement | null)?.contains(event.target as Node))
        close();
    };
    document.addEventListener("focusin", focusEntered);
    document.addEventListener("focusout", focusLeft);
    trigger.addEventListener("keydown", activateClosedTrigger);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("focusin", focusEntered);
      document.removeEventListener("focusout", focusLeft);
      trigger.removeEventListener("keydown", activateClosedTrigger);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
    };
  }, [clearGraceTimer, keyPressed, open, openNow, scheduleClose]);

  // While open, the safe zone covers trigger + content + the bridge between
  // them. Close only fires when the pointer leaves the safe zone; re-entering
  // it (including the bridge) cancels the pending close.
  useHoverSafeZone({
    enabled: open,
    triggerRef,
    contentRef,
    onEnterSafeZone: clearGraceTimer,
    onLeaveSafeZone: scheduleClose,
  });

  useEffect(() => {
    if (disabled) {
      clearGraceTimer();
      setOpen(false);
    }
  }, [clearGraceTimer, disabled]);

  useEffect(() => clearGraceTimer, [clearGraceTimer]);

  const value = useMemo<HoverCardContextValue>(
    () => ({ open, layer, setTriggerRef, triggerRef, contentRef, openNow, scheduleClose }),
    [open, layer, setTriggerRef, openNow, scheduleClose],
  );

  return (
    <OverlayLayerProvider layer={layer}>
      <HoverCardContext.Provider value={value}>{children}</HoverCardContext.Provider>
    </OverlayLayerProvider>
  );
}

export function HoverCardTrigger({
  children,
  focusable = false,
  accessibilityLabel,
}: {
  children: ReactNode;
  focusable?: boolean;
  accessibilityLabel?: string;
}): ReactNode {
  const ctx = useContext(HoverCardContext);
  if (!ctx) return children;
  return (
    <View
      ref={ctx.setTriggerRef}
      tabIndex={focusable ? 0 : undefined}
      accessibilityRole={focusable ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      collapsable={false}
      onPointerEnter={ctx.openNow}
      onPointerLeave={ctx.scheduleClose}
    >
      {children}
    </View>
  );
}

interface HoverCardContentProps {
  placement: Placement;
  alignment?: Alignment;
  offset?: number;
  /** Layered over the default popover surface. */
  style?: StyleProp<ViewStyle>;
  role?: Role;
  accessibilityLabel?: string;
  testID?: string;
  /** Mounted only while the card is open, so whatever it fetches runs only then. */
  children: ReactNode;
}

export function HoverCardContent(props: HoverCardContentProps): ReactElement | null {
  const ctx = useContext(HoverCardContext);
  if (!ctx?.open) return null;
  return (
    <HoverCardSurface
      {...props}
      layer={ctx.layer}
      triggerRef={ctx.triggerRef}
      contentRef={ctx.contentRef}
    />
  );
}

function HoverCardSurface({
  layer,
  triggerRef,
  contentRef,
  placement,
  alignment = "center",
  offset = 4,
  style,
  role,
  accessibilityLabel,
  testID,
  children,
}: HoverCardContentProps & {
  layer: number;
  triggerRef: RefObject<View | null>;
  contentRef: RefObject<View | null>;
}): ReactElement {
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<Size | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!triggerRef.current) return;
    let cancelled = false;
    void measureElement(triggerRef.current).then((rect) => {
      if (!cancelled) setTriggerRect(rect);
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [triggerRef]);

  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width, height } = Dimensions.get("window");
    const { x, y } = computePosition({
      triggerRect,
      contentSize,
      displayArea: { x: 0, y: 0, width, height },
      placement,
      flipHorizontal: true,
      alignment,
      offset,
    });
    setPosition({ x, y });
  }, [alignment, contentSize, offset, placement, triggerRect]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  const frameStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: position?.y ?? -9999,
      left: position?.x ?? -9999,
    }),
    [position?.x, position?.y],
  );
  const surfaceStyle = useMemo(() => [styles.surface, style], [style]);

  return (
    <Portal hostName={bottomSheetInternal?.hostName}>
      <View pointerEvents="box-none" style={[styles.portalOverlay, { zIndex: layer }]}>
        <FloatingSurface
          ref={contentRef}
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          onLayout={handleLayout}
          role={role}
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          style={surfaceStyle}
          frameStyle={frameStyle}
        >
          {children}
        </FloatingSurface>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create((theme) => ({
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
  surface: {
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.xl,
    ...theme.shadow.md,
    zIndex: 1000,
  },
}));
