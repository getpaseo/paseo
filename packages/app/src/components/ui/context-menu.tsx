import {
  type ComponentProps,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
  type Ref,
  type MutableRefObject,
} from "react";
import {
  ActivityIndicator,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, CheckCircle } from "lucide-react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb, isNative } from "@/constants/platform";
import { useWebScrollbarStyle } from "@/hooks/use-web-scrollbar-style";

// Keep parity with dropdown-menu action statuses.
export type ActionStatus = "idle" | "pending" | "success";

type Placement = "top" | "bottom" | "left" | "right";
type Alignment = "start" | "center" | "end";
type MobileMenuMode = "dropdown" | "sheet";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ContextMenuContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<View | null>;
  anchorRect: Rect | null;
  setAnchorRect: (rect: Rect | null) => void;
};

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null);

function useContextMenuContext(componentName: string): ContextMenuContextValue {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <ContextMenu />`);
  }
  return ctx;
}

export function useContextMenu(): ContextMenuContextValue {
  return useContextMenuContext("useContextMenu");
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

function computePosition({
  triggerRect,
  contentSize,
  displayArea,
  placement,
  alignment,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  placement: Placement;
  alignment: Alignment;
  offset: number;
}): { x: number; y: number; actualPlacement: Placement } {
  const { width: contentWidth, height: contentHeight } = contentSize;

  // Calculate available space
  const spaceTop = triggerRect.y - displayArea.y;
  const spaceBottom = displayArea.y + displayArea.height - (triggerRect.y + triggerRect.height);

  // Flip if needed
  let actualPlacement = placement;
  if (placement === "bottom" && spaceBottom < contentHeight && spaceTop > spaceBottom) {
    actualPlacement = "top";
  } else if (placement === "top" && spaceTop < contentHeight && spaceBottom > spaceTop) {
    actualPlacement = "bottom";
  }

  let x: number;
  let y: number;

  // Position based on placement
  if (actualPlacement === "bottom") {
    y = triggerRect.y + triggerRect.height + offset;
  } else if (actualPlacement === "top") {
    y = triggerRect.y - contentHeight - offset;
  } else if (actualPlacement === "left") {
    x = triggerRect.x - contentWidth - offset;
    y = triggerRect.y;
  } else {
    x = triggerRect.x + triggerRect.width + offset;
    y = triggerRect.y;
  }

  // Alignment
  if (actualPlacement === "top" || actualPlacement === "bottom") {
    if (alignment === "start") {
      x = triggerRect.x;
    } else if (alignment === "end") {
      x = triggerRect.x + triggerRect.width - contentWidth;
    } else {
      x = triggerRect.x + (triggerRect.width - contentWidth) / 2;
    }
  }

  // Constrain to screen
  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentWidth - padding, x!));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentHeight - padding, y!),
  );

  return { x, y, actualPlacement };
}

function coerceEventPoint(event: unknown): { pageX: number; pageY: number } | null {
  const nativeEvent: any = (event as any)?.nativeEvent ?? event;
  const pageX = nativeEvent?.pageX;
  const pageY = nativeEvent?.pageY;
  if (typeof pageX === "number" && typeof pageY === "number") {
    return { pageX, pageY };
  }
  const clientX = nativeEvent?.clientX;
  const clientY = nativeEvent?.clientY;
  if (typeof clientX === "number" && typeof clientY === "number") {
    return { pageX: clientX, pageY: clientY };
  }
  return null;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref && typeof ref === "object") {
    (ref as MutableRefObject<T>).current = value;
  }
}

export function ContextMenu({
  open,
  defaultOpen,
  onOpenChange,
  children,
}: PropsWithChildren<{
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}>): ReactElement {
  const triggerRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useControllableOpenState({
    open,
    defaultOpen,
    onOpenChange,
  });
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setAnchorRect(null);
    }
  }, [isOpen]);

  const value = useMemo<ContextMenuContextValue>(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
      anchorRect,
      setAnchorRect,
    }),
    [anchorRect, isOpen, setAnchorRect, setIsOpen],
  );

  return <ContextMenuContext.Provider value={value}>{children}</ContextMenuContext.Provider>;
}

type TriggerState = { pressed: boolean; hovered: boolean; open: boolean };
type TriggerStyleProp = StyleProp<ViewStyle> | ((state: TriggerState) => StyleProp<ViewStyle>);

export function ContextMenuTrigger({
  children,
  disabled,
  style,
  enabled = true,
  enabledOnMobile = false,
  enabledOnWeb = true,
  longPressDelayMs,
  triggerRef,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, "style"> & {
    style?: TriggerStyleProp;
    enabled?: boolean;
    enabledOnMobile?: boolean;
    enabledOnWeb?: boolean;
    longPressDelayMs?: number;
    triggerRef?: Ref<View | null>;
  }
>): ReactElement {
  const ctx = useContextMenuContext("ContextMenuTrigger");

  const shouldEnableOnThisPlatform = enabled && (isWeb ? enabledOnWeb : enabledOnMobile);

  const openAtEvent = useCallback(
    (event: unknown) => {
      if (!shouldEnableOnThisPlatform || disabled) {
        return;
      }
      const point = coerceEventPoint(event);
      if (!point) {
        return;
      }
      const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
      ctx.setAnchorRect({
        x: point.pageX,
        y: point.pageY + statusBarHeight,
        width: 0,
        height: 0,
      });
      ctx.setOpen(true);
    },
    [ctx, disabled, shouldEnableOnThisPlatform],
  );

  const handleRef = useCallback(
    (node: View | null) => {
      assignRef(ctx.triggerRef, node);
      assignRef(triggerRef, node);
    },
    [ctx.triggerRef, triggerRef],
  );

  return (
    <Pressable
      {...props}
      ref={handleRef}
      collapsable={false}
      disabled={disabled}
      delayLongPress={longPressDelayMs}
      onLongPress={(event) => {
        if (isWeb) {
          props.onLongPress?.(event);
          return;
        }
        openAtEvent(event);
        props.onLongPress?.(event);
      }}
      // @ts-ignore - onContextMenu is web-only and not in RN types.
      onContextMenu={(event: unknown) => {
        if (isNative) {
          return;
        }
        const e: any = event;
        e?.preventDefault?.();
        e?.stopPropagation?.();
        openAtEvent(event);
      }}
      style={({ pressed, hovered = false }) => {
        if (typeof style === "function") {
          return style({ pressed, hovered: Boolean(hovered), open: ctx.open });
        }
        return style;
      }}
    >
      {children}
    </Pressable>
  );
}

export function ContextMenuContent({
  children,
  side = "bottom",
  align = "start",
  offset = 4,
  width,
  minWidth = 180,
  maxWidth,
  fullWidth = false,
  horizontalPadding = 16,
  mobileMode = "dropdown",
  testID,
}: PropsWithChildren<{
  side?: Placement;
  align?: Alignment;
  offset?: number;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  fullWidth?: boolean;
  horizontalPadding?: number;
  mobileMode?: MobileMenuMode;
  testID?: string;
}>): ReactElement | null {
  const context = useContextMenuContext("ContextMenuContent");
  const webScrollbarStyle = useWebScrollbarStyle();
  const isMobile = useIsCompactFormFactor();
  const useMobileSheet = isMobile && mobileMode === "sheet";
  const { open, setOpen, triggerRef, anchorRect } = context;
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const sheetSnapPoints = useMemo(() => ["30%", "55%"], []);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  useEffect(() => {
    if (!useMobileSheet) return;
    if (open) {
      bottomSheetRef.current?.present();
      return;
    }
    bottomSheetRef.current?.dismiss();
  }, [open, useMobileSheet]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        handleClose();
      }
    },
    [handleClose],
  );

  const renderSheetBackdrop = useCallback(
    (props: ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.45} />
    ),
    [],
  );

  // Measure trigger when opening (fallback) and capture point anchors.
  useEffect(() => {
    if (useMobileSheet) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return;
    }

    if (!open) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return;
    }

    if (anchorRect) {
      setTriggerRect(anchorRect);
      return;
    }

    if (!triggerRef.current) {
      setTriggerRect(null);
      return;
    }

    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;

    measureElement(triggerRef.current).then((rect) => {
      if (cancelled) return;
      setTriggerRect({
        ...rect,
        y: rect.y + statusBarHeight,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [anchorRect, open, triggerRef, useMobileSheet]);

  // Calculate position when we have both measurements
  useEffect(() => {
    if (useMobileSheet) return;
    if (!triggerRect || !contentSize) return;

    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = {
      x: 0,
      y: 0,
      width: screenWidth,
      height: screenHeight,
    };

    const result = computePosition({
      triggerRect,
      contentSize,
      displayArea,
      placement: side,
      alignment: align,
      offset,
    });

    const x = fullWidth ? horizontalPadding : result.x;
    setPosition({ x, y: result.y });
  }, [triggerRect, contentSize, side, align, offset, fullWidth, horizontalPadding, useMobileSheet]);

  const handleContentLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width: w, height: h } = event.nativeEvent.layout;
      setContentSize({ width: w, height: h });
    },
    [],
  );

  if (useMobileSheet) {
    return (
      <ContextMenuContext.Provider value={context}>
        <BottomSheetModal
          ref={bottomSheetRef}
          index={0}
          snapPoints={sheetSnapPoints}
          enableDynamicSizing={false}
          onChange={handleSheetChange}
          backdropComponent={renderSheetBackdrop}
          enablePanDownToClose
          backgroundStyle={styles.sheetBackground}
          handleIndicatorStyle={styles.sheetHandle}
          keyboardBehavior="extend"
          keyboardBlurBehavior="restore"
        >
          <BottomSheetScrollView
            contentContainerStyle={styles.sheetScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            testID={testID ? `${testID}-content` : undefined}
          >
            {children}
          </BottomSheetScrollView>
        </BottomSheetModal>
      </ContextMenuContext.Provider>
    );
  }

  if (!open) return null;

  const { width: screenWidth } = Dimensions.get("window");
  const resolvedWidthStyle: ViewStyle = fullWidth
    ? { width: screenWidth - horizontalPadding * 2 }
    : {
        ...(typeof width === "number" ? { width } : null),
        ...(typeof minWidth === "number" ? { minWidth } : null),
        ...(typeof maxWidth === "number" ? { maxWidth } : null),
      };

  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={handleClose}
    >
      <View style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu backdrop"
          style={styles.backdrop}
          onPress={handleClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
        <Animated.View
          entering={FadeIn.duration(100)}
          exiting={FadeOut.duration(100)}
          collapsable={false}
          testID={testID}
          onLayout={handleContentLayout}
          style={[
            styles.content,
            resolvedWidthStyle,
            {
              position: "absolute",
              top: position?.y ?? -9999,
              left: position?.x ?? -9999,
            },
          ]}
        >
          <ScrollView
            bounces={false}
            showsVerticalScrollIndicator
            style={webScrollbarStyle}
            contentContainerStyle={{ flexGrow: 1 }}
          >
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function ContextMenuLabel({
  children,
  style,
  testID,
}: PropsWithChildren<{ style?: ViewStyle | ViewStyle[]; testID?: string }>): ReactElement {
  return (
    <View style={[styles.labelContainer, style]} testID={testID}>
      <Text style={styles.labelText}>{children}</Text>
    </View>
  );
}

export function ContextMenuSeparator({
  style,
  testID,
}: {
  style?: ViewStyle;
  testID?: string;
}): ReactElement {
  return <View style={[styles.separator, style]} testID={testID} />;
}

export function ContextMenuHint({
  children,
  testID,
}: PropsWithChildren<{ testID?: string }>): ReactElement {
  return (
    <View style={styles.hintContainer} testID={testID}>
      <Text style={styles.hintText}>{children}</Text>
    </View>
  );
}

export function ContextMenuItem({
  children,
  description,
  onSelect,
  disabled,
  destructive,
  selected,
  showSelectedCheck = false,
  selectedVariant = "default",
  leading,
  trailing,
  loading,
  status,
  pendingLabel,
  successLabel,
  closeOnSelect = true,
  testID,
  tooltip,
}: PropsWithChildren<{
  description?: string;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  selected?: boolean;
  showSelectedCheck?: boolean;
  selectedVariant?: "default" | "accent";
  leading?: ReactElement | null;
  trailing?: ReactElement | null;
  /** @deprecated Use `status` instead */
  loading?: boolean;
  status?: ActionStatus;
  pendingLabel?: string;
  successLabel?: string;
  closeOnSelect?: boolean;
  testID?: string;
  tooltip?: string;
}>): ReactElement {
  const { theme } = useUnistyles();
  const { setOpen } = useContextMenuContext("ContextMenuItem");

  const isPending = status === "pending" || loading;
  const isSuccess = status === "success";
  const isDisabled = disabled || isPending || isSuccess;

  let leadingContent: ReactElement | null = null;
  if (isPending) {
    leadingContent = <ActivityIndicator size={16} color={theme.colors.foregroundMuted} />;
  } else if (isSuccess) {
    leadingContent = <CheckCircle size={16} color={theme.colors.palette.green[500]} />;
  } else if (leading) {
    leadingContent = leading;
  }

  let label = children;
  if (isPending && pendingLabel) {
    label = pendingLabel;
  } else if (isSuccess && successLabel) {
    label = successLabel;
  }

  const trailingContent =
    trailing ??
    (!showSelectedCheck && selected ? (
      <Check size={16} color={theme.colors.foregroundMuted} />
    ) : null);

  const content = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={() => {
        if (isDisabled) return;
        if (closeOnSelect) {
          setOpen(false);
        }
        onSelect?.();
      }}
      style={({ pressed, hovered }) => [
        styles.item,
        selected
          ? selectedVariant === "accent"
            ? styles.itemSelectedAccent
            : styles.itemSelected
          : null,
        selected && (hovered || pressed) && selectedVariant !== "accent"
          ? styles.itemSelectedInteractive
          : null,
        isDisabled ? styles.itemDisabled : null,
        hovered && !pressed && !isDisabled ? styles.itemHovered : null,
        pressed && !isDisabled ? styles.itemPressed : null,
      ]}
    >
      {showSelectedCheck ? (
        <View style={styles.checkSlot}>
          {selected ? <Check size={16} color={theme.colors.foreground} /> : null}
        </View>
      ) : null}
      {leadingContent ? <View style={styles.leadingSlot}>{leadingContent}</View> : null}
      <View style={styles.itemContent}>
        <Text
          numberOfLines={1}
          style={[
            styles.itemText,
            destructive && !isSuccess ? styles.itemTextDestructive : null,
            isSuccess ? styles.itemTextSuccess : null,
            selected && selectedVariant === "accent" ? styles.itemTextSelectedAccent : null,
          ]}
        >
          {label}
        </Text>
        {description && !isPending && !isSuccess ? (
          <Text
            numberOfLines={2}
            style={[
              styles.itemDescription,
              selected && selectedVariant === "accent"
                ? styles.itemDescriptionSelectedAccent
                : null,
            ]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      {trailingContent ? <View style={styles.trailingSlot}>{trailingContent}</View> : null}
    </Pressable>
  );

  if (!tooltip) {
    return content;
  }

  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right" align="center" offset={10}>
        <Text style={styles.tooltipText}>{tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  content: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    ...theme.shadow.md,
    overflow: "hidden",
  },
  sheetBackground: {
    backgroundColor: theme.colors.surface0,
    borderTopLeftRadius: theme.borderRadius.xl,
    borderTopRightRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sheetHandle: {
    backgroundColor: theme.colors.surface2,
  },
  sheetScrollContent: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[4],
  },
  labelContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  labelText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  hintContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  hintText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  itemHovered: {
    backgroundColor: theme.colors.surface1,
  },
  itemPressed: {
    backgroundColor: theme.colors.surface1,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemSelected: {
    backgroundColor: theme.colors.surface1,
  },
  itemSelectedInteractive: {
    backgroundColor: theme.colors.surface1,
  },
  itemSelectedAccent: {
    backgroundColor: theme.colors.accent,
  },
  checkSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  leadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  trailingSlot: {
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  itemContent: {
    flexShrink: 1,
  },
  itemText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  itemTextDestructive: {
    color: theme.colors.destructive,
  },
  itemTextSuccess: {
    color: theme.colors.palette.green[500],
  },
  itemTextSelectedAccent: {
    color: theme.colors.accentForeground,
  },
  itemDescription: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  itemDescriptionSelectedAccent: {
    color: theme.colors.accentForeground,
    opacity: 0.85,
  },
}));
