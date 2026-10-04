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
  const triggerRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const scheduleClose = useCallback(() => {
    if (focusInside()) return;
    if (graceTimerRef.current) return;
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, [focusInside]);

  const openNow = useCallback(() => {
    clearGraceTimer();
    if (!disabled) {
      setOpen(true);
    }
  }, [clearGraceTimer, disabled]);

  useEffect(() => {
    if (!isWeb) return;
    const trigger = triggerRef.current as unknown as HTMLElement | null;
    if (!trigger) return;
    const close = () => {
      clearGraceTimer();
      setOpen(false);
    };
    const focusEntered = (event: FocusEvent) => {
      const target = event.target as Node;
      if (trigger.contains(target)) openNow();
      else if ((contentRef.current as unknown as HTMLElement | null)?.contains(target))
        clearGraceTimer();
    };
    const focusLeft = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (
        !trigger.contains(next) &&
        !(contentRef.current as unknown as HTMLElement | null)?.contains(next)
      )
        scheduleClose();
    };
    const keyPressed = (event: KeyboardEvent) => {
      if (!focusInside()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        trigger.focus();
        close();
      } else if (event.target === trigger && ["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openNow();
        requestAnimationFrame(() => {
          (contentRef.current as unknown as HTMLElement | null)
            ?.querySelector<HTMLElement>(
              'button, [role="button"][tabindex="0"], a[href], input, [tabindex="0"]',
            )
            ?.focus();
        });
      }
    };
    const scrolled = (event: Event) => {
      if (!(contentRef.current as unknown as HTMLElement | null)?.contains(event.target as Node))
        close();
    };
    document.addEventListener("focusin", focusEntered);
    document.addEventListener("focusout", focusLeft);
    document.addEventListener("keydown", keyPressed);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("focusin", focusEntered);
      document.removeEventListener("focusout", focusLeft);
      document.removeEventListener("keydown", keyPressed);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
    };
  }, [clearGraceTimer, focusInside, openNow, scheduleClose]);

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
    () => ({ open, triggerRef, contentRef, openNow, scheduleClose }),
    [open, openNow, scheduleClose],
  );

  return <HoverCardContext.Provider value={value}>{children}</HoverCardContext.Provider>;
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
      ref={ctx.triggerRef}
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
  return <HoverCardSurface {...props} triggerRef={ctx.triggerRef} contentRef={ctx.contentRef} />;
}

function HoverCardSurface({
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
      <View pointerEvents="box-none" style={styles.portalOverlay}>
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
