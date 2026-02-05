import {
  createContext,
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

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type TooltipContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<View | null>;
  enabled: boolean;
  delayDuration: number;
};

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltipContext(componentName: string): TooltipContextValue {
  const ctx = useContext(TooltipContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <Tooltip />`);
  }
  return ctx;
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
  const value = isControlled ? Boolean(open) : internalOpen;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
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

  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom =
    displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);
  const spaceLeft = triggerRect.x - displayArea.x;
  const spaceRight =
    displayArea.x + displayArea.width - (triggerRect.x + triggerRect.width);

  let actualSide = side;
  if (side === "bottom" && spaceBottom < contentHeight && spaceTop > spaceBottom) {
    actualSide = "top";
  } else if (side === "top" && spaceTop < contentHeight && spaceBottom > spaceTop) {
    actualSide = "bottom";
  } else if (side === "left" && spaceLeft < contentWidth && spaceRight > spaceLeft) {
    actualSide = "right";
  } else if (side === "right" && spaceRight < contentWidth && spaceLeft > spaceRight) {
    actualSide = "left";
  }

  let x = 0;
  let y = 0;

  if (actualSide === "bottom") {
    y = triggerRect.y + triggerRect.height + offset;
    if (align === "start") {
      x = triggerRect.x;
    } else if (align === "end") {
      x = triggerRect.x + triggerRect.width - contentWidth;
    } else {
      x = triggerRect.x + (triggerRect.width - contentWidth) / 2;
    }
  } else if (actualSide === "top") {
    y = triggerRect.y - contentHeight - offset;
    if (align === "start") {
      x = triggerRect.x;
    } else if (align === "end") {
      x = triggerRect.x + triggerRect.width - contentWidth;
    } else {
      x = triggerRect.x + (triggerRect.width - contentWidth) / 2;
    }
  } else if (actualSide === "left") {
    x = triggerRect.x - contentWidth - offset;
    if (align === "start") {
      y = triggerRect.y;
    } else if (align === "end") {
      y = triggerRect.y + triggerRect.height - contentHeight;
    } else {
      y = triggerRect.y + (triggerRect.height - contentHeight) / 2;
    }
  } else {
    x = triggerRect.x + triggerRect.width + offset;
    if (align === "start") {
      y = triggerRect.y;
    } else if (align === "end") {
      y = triggerRect.y + triggerRect.height - contentHeight;
    } else {
      y = triggerRect.y + (triggerRect.height - contentHeight) / 2;
    }
  }

  const padding = 8;
  x = Math.max(
    padding,
    Math.min(displayArea.width - contentWidth - padding, x)
  );
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentHeight - padding, y)
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

  const isWeb = Platform.OS === "web";
  const isMobileWeb =
    isWeb &&
    typeof navigator !== "undefined" &&
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? "");
  const enabled = isWeb ? (isMobileWeb ? enabledOnMobile : enabledOnDesktop) : enabledOnMobile;

  const value = useMemo<TooltipContextValue>(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
      enabled,
      delayDuration,
    }),
    [isOpen, setIsOpen, enabled, delayDuration]
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
  ...props
}: PropsWithChildren<PressableProps>): ReactElement {
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
    (e?: any) => {
      onHoverIn?.(e);
      scheduleOpen();
    },
    [onHoverIn, scheduleOpen]
  );

  const handleHoverOut = useCallback(
    (e?: any) => {
      onHoverOut?.(e);
      close();
    },
    [onHoverOut, close]
  );

  return (
    <Pressable
      {...props}
      ref={ctx.triggerRef}
      collapsable={false}
      disabled={disabled}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onFocus={(e) => {
        onFocus?.(e);
        if (!ctx.enabled || disabled) return;
        clearOpenTimer();
        ctx.setOpen(true);
      }}
      onBlur={(e) => {
        onBlur?.(e);
        close();
      }}
      onPress={(e) => {
        onPress?.(e);
        close();
      }}
      {...(Platform.OS === "web"
        ? ({
            // RN Web's hover handling can vary across environments; pointer events are the most reliable.
            onPointerEnter: handleHoverIn,
            onPointerLeave: handleHoverOut,
            onMouseEnter: handleHoverIn,
            onMouseLeave: handleHoverOut,
          } as any)
        : null)}
    >
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
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(
    null
  );
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ctx.open || !ctx.enabled || !ctx.triggerRef.current) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return;
    }

    const statusBarHeight =
      Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;

    measureElement(ctx.triggerRef.current).then((rect) => {
      if (cancelled) return;
      setTriggerRect({ ...rect, y: rect.y + statusBarHeight });
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
    []
  );

  if (!ctx.open || !ctx.enabled) return null;

  // On web, avoid React Native's <Modal/> implementation (it uses <dialog> and can
  // steal focus / disrupt hover). Rendering via Portal + position:fixed keeps the
  // exact same positioning math as DropdownMenu, without hover feedback loops.
  if (Platform.OS === "web") {
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
            style={[
              styles.content,
              { maxWidth },
              style,
              {
                position: "absolute",
                top: position?.y ?? -9999,
                left: position?.x ?? -9999,
              },
            ]}
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
      onRequestClose={() => ctx.setOpen(false)}
    >
      <View pointerEvents="box-none" style={styles.overlay}>
        <Animated.View
          pointerEvents="none"
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          testID={testID}
          onLayout={handleLayout}
          style={[
            styles.content,
            { maxWidth },
            style,
            {
              position: "absolute",
              top: position?.y ?? -9999,
              left: position?.x ?? -9999,
            },
          ]}
        >
          {children}
        </Animated.View>
      </View>
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
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.popover,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    zIndex: 1000,
  },
}));
