import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import {
  Dimensions,
  Platform,
  Modal,
  Pressable,
  StatusBar,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Portal } from "@gorhom/portal";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TooltipContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<View | null>;
  enabled: boolean;
  openOnPress: boolean;
  delayDuration: number;
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltipContext(componentName: string): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <Tooltip />`);
  }
  return ctx;
}

// Tooltips should open on hover or keyboard focus, not when focus is restored
// programmatically (e.g. when a Modal closes and returns focus to its opener).
// Track the last input modality on web so TooltipTrigger can ignore focus
// events that weren't keyboard-driven. Native has no equivalent scenario.
let lastInputWasKeyboard = false;
if (isWeb && typeof window !== "undefined") {
  const markKeyboard = () => {
    lastInputWasKeyboard = true;
  };
  const markPointer = () => {
    lastInputWasKeyboard = false;
  };
  window.addEventListener("keydown", markKeyboard, true);
  window.addEventListener("mousedown", markPointer, true);
  window.addEventListener("pointerdown", markPointer, true);
  window.addEventListener("touchstart", markPointer, true);
}

function shouldOpenOnFocus(): boolean {
  return !isWeb || lastInputWasKeyboard;
}

function isCallable(fn: unknown): fn is (...args: unknown[]) => void {
  return typeof fn === "function";
}

function composeEventHandlers(
  original: unknown,
  injected: (event: unknown) => void,
): (event: unknown) => void {
  return (event: unknown) => {
    if (isCallable(original)) {
      original(event);
    }
    injected(event);
  };
}

function useControllableOpenState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}): [boolean, (next: boolean) => void] {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const isControlled = typeof open === "boolean";
  const value = isControlled ? open : internalOpen;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return [value, setValue];
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function resolveActualSide(args: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
}): Side {
  const { triggerRect, contentSize, displayArea, side } = args;
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);
  const spaceLeft = triggerRect.x - displayArea.x;
  const spaceRight = displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);

  if (side === "bottom" && spaceBottom < contentSize.height && spaceTop > spaceBottom) return "top";
  if (side === "top" && spaceTop < contentSize.height && spaceBottom > spaceTop) return "bottom";
  if (side === "left" && spaceLeft < contentSize.width && spaceRight > spaceLeft) return "right";
  if (side === "right" && spaceRight < contentSize.width && spaceLeft > spaceRight) return "left";
  return side;
}

function resolveAlignedCoordinate(args: {
  align: Align;
  start: number;
  size: number;
  contentSize: number;
}): number {
  const { align, start, size, contentSize } = args;
  if (align === "start") return start;
  if (align === "end") return start + size - contentSize;
  return start + (size - contentSize) / 2;
}

function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  side,
  align,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  side: Side;
  align: Align;
  offset: number;
}): { x: number; y: number; actualSide: Side } {
  const { width: contentWidth, height: contentHeight } = contentSize;
  const actualSide = resolveActualSide({ triggerRect, contentSize, displayArea, side });

  let x = 0;
  let y = 0;

  if (actualSide === "bottom") {
    y = triggerRect.y + triggerRect.height + offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "top") {
    y = triggerRect.y - contentHeight - offset;
    x = resolveAlignedCoordinate({
      align,
      start: triggerRect.x,
      size: triggerRect.width,
      contentSize: contentWidth,
    });
  } else if (actualSide === "left") {
    x = triggerRect.x - contentWidth - offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  } else {
    x = triggerRect.x + triggerRect.width + offset;
    y = resolveAlignedCoordinate({
      align,
      start: triggerRect.y,
      size: triggerRect.height,
      contentSize: contentHeight,
    });
  }

  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentWidth - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentHeight - padding, y),
  );

  return { x, y, actualSide };
}

export function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delayDuration = 0,
  enabledOnDesktop = true,
  enabledOnMobile = false,
  children,
}: PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
  enabledOnDesktop?: boolean;
  enabledOnMobile?: boolean;
}>): ReactElement {
  const triggerRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useControllableOpenState({
    open,
    defaultOpen,
    onOpenChange,
  });

  const isCompact = useIsCompactFormFactor();
  const enabled = isCompact ? enabledOnMobile : enabledOnDesktop;

  const value = useMemo<TooltipContextValue>(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
      enabled,
      openOnPress: isCompact,
      delayDuration,
    }),
    [isOpen, setIsOpen, enabled, isCompact, delayDuration],
  );

  return <TooltipContext.Provider value={value}>{children}</TooltipContext.Provider>;
}

export function TooltipTrigger({
  children,
  disabled,
  onHoverIn,
  onHoverOut,
  onFocus,
  onBlur,
  onPress,
  asChild = false,
  triggerRefProp = "ref",
  ...props
}: PressableProps & {
  asChild?: boolean;
  triggerRefProp?: string;
}): ReactElement {
  const ctx = useTooltipContext("TooltipTrigger");
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (!ctx.enabled || disabled) return;
    clearOpenTimer();
    if (ctx.delayDuration <= 0) {
      ctx.setOpen(true);
      return;
    }
    openTimerRef.current = setTimeout(() => {
      ctx.setOpen(true);
      openTimerRef.current = null;
    }, ctx.delayDuration);
  }, [clearOpenTimer, ctx, disabled]);

  const close = useCallback(() => {
    clearOpenTimer();
    ctx.setOpen(false);
  }, [clearOpenTimer, ctx]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
    };
  }, [clearOpenTimer]);

  const handleHoverIn = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverIn)) onHoverIn(e);
      scheduleOpen();
    },
    [onHoverIn, scheduleOpen],
  );

  const handleHoverOut = useCallback(
    (e?: unknown) => {
      if (isCallable(onHoverOut)) onHoverOut(e);
      close();
    },
    [onHoverOut, close],
  );

  const handleFocus = useCallback(
    (e: unknown) => {
      if (isCallable(onFocus)) onFocus(e);
      if (!ctx.enabled || disabled) return;
      if (!shouldOpenOnFocus()) return;
      clearOpenTimer();
      ctx.setOpen(true);
    },
    [clearOpenTimer, ctx, disabled, onFocus],
  );

  const handleBlur = useCallback(
    (e: unknown) => {
      if (isCallable(onBlur)) onBlur(e);
      close();
    },
    [close, onBlur],
  );

  const handlePress = useCallback(
    (e: unknown) => {
      if (isCallable(onPress)) onPress(e);
      if (!ctx.enabled || disabled) {
        return;
      }
      if (ctx.openOnPress) {
        clearOpenTimer();
        ctx.setOpen(true);
        return;
      }
      close();
    },
    [clearOpenTimer, close, ctx, disabled, onPress],
  );

  const triggerProps = {
    ...props,
    disabled,
    onHoverIn: handleHoverIn,
    onHoverOut: handleHoverOut,
    onFocus: handleFocus,
    onBlur: handleBlur,
    onPress: handlePress,
    ...(isWeb
      ? ({
          // RN Web's hover handling can vary across environments; pointer events are the most reliable.
          onPointerEnter: handleHoverIn,
          onPointerLeave: handleHoverOut,
          onMouseEnter: handleHoverIn,
          onMouseLeave: handleHoverOut,
        } as object)
      : null),
  };

  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement(child)) {
      throw new Error("TooltipTrigger with asChild expects a single React element child");
    }

    const rawProps: unknown = child.props;
    if (typeof rawProps !== "object" || rawProps === null) {
      throw new Error("TooltipTrigger asChild child must have props object");
    }
    const mergedProps: Record<string, unknown> = {
      ...Object.assign({}, rawProps),
      ...triggerProps,
      disabled: Reflect.get(rawProps, "disabled") || disabled,
      onHoverIn: composeEventHandlers(Reflect.get(rawProps, "onHoverIn"), handleHoverIn),
      onHoverOut: composeEventHandlers(Reflect.get(rawProps, "onHoverOut"), handleHoverOut),
      onFocus: composeEventHandlers(Reflect.get(rawProps, "onFocus"), handleFocus),
      onBlur: composeEventHandlers(Reflect.get(rawProps, "onBlur"), handleBlur),
      onPress: composeEventHandlers(Reflect.get(rawProps, "onPress"), handlePress),
      onPointerEnter: composeEventHandlers(Reflect.get(rawProps, "onPointerEnter"), handleHoverIn),
      onPointerLeave: composeEventHandlers(Reflect.get(rawProps, "onPointerLeave"), handleHoverOut),
      onMouseEnter: composeEventHandlers(Reflect.get(rawProps, "onMouseEnter"), handleHoverIn),
      onMouseLeave: composeEventHandlers(Reflect.get(rawProps, "onMouseLeave"), handleHoverOut),
    };

    const existingRefProp = Reflect.get(rawProps, triggerRefProp);
    mergedProps[triggerRefProp] = (node: View) => {
      if (isCallable(existingRefProp)) {
        existingRefProp(node);
      } else if (existingRefProp && typeof existingRefProp === "object") {
        Object.assign(existingRefProp, { current: node });
      }
      Object.assign(ctx.triggerRef, { current: node });
    };

    return cloneElement(child, mergedProps);
  }

  return (
    <Pressable {...triggerProps} ref={ctx.triggerRef} collapsable={false}>
      {children}
    </Pressable>
  );
}

export function TooltipContent({
  children,
  side = "top",
  align = "center",
  offset = 6,
  style,
  testID,
  maxWidth = 280,
}: PropsWithChildren<{
  side?: Side;
  align?: Align;
  offset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  maxWidth?: number;
}>): ReactElement | null {
  const ctx = useTooltipContext("TooltipContent");
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ctx.open || !ctx.enabled || !ctx.triggerRef.current) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return () => {};
    }

    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;

    void measureElement(ctx.triggerRef.current).then((rect) => {
      if (!cancelled) setTriggerRect({ ...rect, y: rect.y + statusBarHeight });
      return undefined;
    });

    return () => {
      cancelled = true;
    };
  }, [ctx.enabled, ctx.open, ctx.triggerRef]);

  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computePosition({
      triggerRect,
      contentSize,
      displayArea,
      side,
      align,
      offset,
    });
    setPosition({ x: result.x, y: result.y });
  }, [triggerRect, contentSize, side, align, offset]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  const contentStyle = useMemo(
    () => [
      styles.content,
      { maxWidth },
      style,
      {
        position: "absolute" as const,
        top: position?.y ?? -9999,
        left: position?.x ?? -9999,
      },
    ],
    [maxWidth, style, position?.x, position?.y],
  );

  const handleDismiss = useCallback(() => ctx.setOpen(false), [ctx]);

  if (!ctx.open || !ctx.enabled) return null;

  // On web, avoid React Native's <Modal/> implementation (it uses <dialog> and can
  // steal focus / disrupt hover). Rendering via Portal + position:fixed keeps the
  // exact same positioning math as DropdownMenu, without hover feedback loops.
  if (isWeb) {
    return (
      <Portal hostName={bottomSheetInternal?.hostName}>
        <View pointerEvents="none" style={styles.portalOverlay}>
          <Animated.View
            pointerEvents="none"
            entering={FadeIn.duration(80)}
            exiting={FadeOut.duration(80)}
            collapsable={false}
            testID={testID}
            onLayout={handleLayout}
            style={contentStyle}
          >
            {children}
          </Animated.View>
        </View>
      </Portal>
    );
  }

  return (
    <Modal
      visible={ctx.open}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={handleDismiss}
    >
      <Pressable style={styles.overlay} onPress={handleDismiss}>
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          testID={testID}
          onLayout={handleLayout}
          style={contentStyle}
        >
          {children}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: { flex: 1 },
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
  content: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    ...theme.shadow.md,
    zIndex: 1000,
  },
}));
