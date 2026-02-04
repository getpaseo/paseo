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
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  Dimensions,
  Platform,
  StatusBar,
  type PressableProps,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, CheckCircle } from "lucide-react-native";

// Action status for menu items with loading/success feedback
export type ActionStatus = "idle" | "pending" | "success";

type Placement = "top" | "bottom" | "left" | "right";
type Alignment = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DropdownMenuContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<View | null>;
};

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

function useDropdownMenuContext(componentName: string): DropdownMenuContextValue {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within <DropdownMenu />`);
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
  y = Math.max(displayArea.y + padding, Math.min(displayArea.y + displayArea.height - contentHeight - padding, y!));

  return { x, y, actualPlacement };
}

export function DropdownMenu({
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

  const value = useMemo<DropdownMenuContextValue>(
    () => ({
      open: isOpen,
      setOpen: setIsOpen,
      triggerRef,
    }),
    [isOpen, setIsOpen]
  );

  return <DropdownMenuContext.Provider value={value}>{children}</DropdownMenuContext.Provider>;
}

type TriggerState = { pressed: boolean; hovered: boolean; open: boolean };
type TriggerStyleProp =
  | StyleProp<ViewStyle>
  | ((state: TriggerState) => StyleProp<ViewStyle>);

interface DropdownMenuTriggerProps extends Omit<PressableProps, "style"> {
  style?: TriggerStyleProp;
}

export function DropdownMenuTrigger({
  children,
  disabled,
  style,
  ...props
}: PropsWithChildren<DropdownMenuTriggerProps>): ReactElement {
  const ctx = useDropdownMenuContext("DropdownMenuTrigger");

  const handlePress = useCallback(() => {
    if (disabled) return;
    ctx.setOpen(!ctx.open);
  }, [disabled, ctx]);

  return (
    <Pressable
      {...props}
      ref={ctx.triggerRef}
      collapsable={false}
      disabled={disabled}
      onPress={handlePress}
      style={({ pressed, hovered }) => {
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

export function DropdownMenuContent({
  children,
  side = "bottom",
  align = "start",
  offset = 4,
  width,
  minWidth = 180,
  maxWidth,
  fullWidth = false,
  horizontalPadding = 16,
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
  testID?: string;
}>): ReactElement | null {
  const { open, setOpen, triggerRef } = useDropdownMenuContext("DropdownMenuContent");
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  // Measure trigger when opening
  useEffect(() => {
    if (!open || !triggerRef.current) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return;
    }

    // Capture status bar height synchronously before async measurement.
    // This avoids race conditions where StatusBar.currentHeight could change
    // or return null if read after the component re-renders.
    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    let cancelled = false;

    measureElement(triggerRef.current).then((rect) => {
      if (cancelled) return;
      // On Android with statusBarTranslucent, measureInWindow returns coordinates
      // relative to below the status bar, but Modal content starts from screen top.
      // Add status bar height to align coordinate systems (same as react-native-popover-view).
      setTriggerRect({
        ...rect,
        y: rect.y + statusBarHeight,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [open, triggerRef]);

  // Calculate position when we have both measurements
  useEffect(() => {
    if (!triggerRect || !contentSize) return;

    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    // measureInWindow returns screen coordinates including status bar
    // Modal also uses full screen coordinates, so displayArea should start at 0
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

    // For fullWidth, x is simply the horizontal padding to center on screen
    const x = fullWidth ? horizontalPadding : result.x;
    setPosition({ x, y: result.y });
  }, [triggerRect, contentSize, side, align, offset, fullWidth, horizontalPadding]);

  const handleContentLayout = useCallback((event: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width: w, height: h } = event.nativeEvent.layout;
    setContentSize({ width: w, height: h });
  }, []);

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
          <ScrollView bounces={false} showsVerticalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
            {children}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function DropdownMenuLabel({
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

export function DropdownMenuSeparator({ style, testID }: { style?: ViewStyle; testID?: string }): ReactElement {
  return <View style={[styles.separator, style]} testID={testID} />;
}

export function DropdownMenuHint({
  children,
  testID,
}: PropsWithChildren<{ testID?: string }>): ReactElement {
  return (
    <View style={styles.hintContainer} testID={testID}>
      <Text style={styles.hintText}>{children}</Text>
    </View>
  );
}

export function DropdownMenuItem({
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
  /** Action status: idle, pending, or success */
  status?: ActionStatus;
  /** Label to show while pending (e.g., "Pushing...") */
  pendingLabel?: string;
  /** Label to show on success (e.g., "Pushed") */
  successLabel?: string;
  closeOnSelect?: boolean;
  testID?: string;
}>): ReactElement {
  const { theme } = useUnistyles();
  const { setOpen } = useDropdownMenuContext("DropdownMenuItem");

  // Derive state from status prop (preferred) or legacy loading prop
  const isPending = status === "pending" || loading;
  const isSuccess = status === "success";
  const isDisabled = disabled || isPending || isSuccess;

  // Determine leading icon based on status
  let leadingContent: ReactElement | null = null;
  if (isPending) {
    leadingContent = <ActivityIndicator size={16} color={theme.colors.foregroundMuted} />;
  } else if (isSuccess) {
    leadingContent = <CheckCircle size={16} color={theme.colors.palette.green[500]} />;
  } else if (leading) {
    leadingContent = leading;
  }

  // Determine label based on status
  let label = children;
  if (isPending && pendingLabel) {
    label = pendingLabel;
  } else if (isSuccess && successLabel) {
    label = successLabel;
  }

  return (
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
      style={({ pressed }) => [
        styles.item,
        selected ? (selectedVariant === "accent" ? styles.itemSelectedAccent : styles.itemSelected) : null,
        destructive && !isSuccess ? styles.itemDestructive : null,
        isDisabled ? styles.itemDisabled : null,
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
              selected && selectedVariant === "accent" ? styles.itemDescriptionSelectedAccent : null,
            ]}
          >
            {description}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailingSlot}>{trailing}</View> : null}
    </Pressable>
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
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
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
  item: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  itemSelected: {
    backgroundColor: theme.colors.surface2,
  },
  itemSelectedAccent: {
    backgroundColor: theme.colors.accent,
  },
  itemDisabled: {
    opacity: 0.5,
  },
  itemDestructive: {
    backgroundColor: "rgba(248, 81, 73, 0.08)",
  },
  itemText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
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
}));
