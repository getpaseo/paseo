import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Keyboard, Pressable, Text, View } from "react-native";
import type {
  AccessibilityActionEvent,
  DimensionValue,
  PointerEvent as RNPointerEvent,
  StyleProp,
  ViewProps,
  ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "../lib/overlay-root";
import {
  BottomSheetHandle,
  useBottomSheetGestureHandlers,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { ArrowLeft, Search, X, type LucideIcon } from "lucide-react-native";
import {
  IsolatedBottomSheetModal,
  SheetVisibleFrame,
  type ContextBridge,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";
import { ScrollView } from "@/components/ui/scroll-view";
import { isWeb } from "@/constants/platform";
import { useKeyboardVisibility } from "@/hooks/use-keyboard-visibility";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
export { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-text-input";

// Horizontal indent token shared by the sheet header (title, back arrow,
// leading icon, search input icon) and any row primitive rendered inside the
// sheet body. Rows whose leading icon should line up with the header must
// match this padding.
export const SHEET_HORIZONTAL_PADDING_SCALE = 6;

// The header's close button grows outward from its glyph, so the glyph's
// trailing rail is the content inset plus this padding. Rows whose trailing
// glyph should line up with the X must reach the same rail.
export const SHEET_HEADER_CLOSE_PADDING_SCALE = 2;

/** The one height a sheet takes when it shows a whole pane rather than sizing to its content. */
export const FULL_SHEET_SNAP_POINTS = ["92%"];

export interface SheetHeaderSearch {
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  resetKey?: string | number;
  placeholder?: string;
  autoFocus?: boolean;
  testID?: string;
}

export interface SheetHeaderBack {
  onPress: () => void;
  label?: string;
  accessibilityLabel?: string;
}

export interface SheetHeader {
  title: string;
  subtitle?: ReactNode;
  back?: SheetHeaderBack;
  leading?: ReactNode;
  actions?: ReactNode;
  search?: SheetHeaderSearch;
}

const SCROLL_CONTENT_GROW = { flexGrow: 1 };
const ABSOLUTE_FILL_STYLE = { ...StyleSheet.absoluteFill };
const NATIVE_DIALOG_SNAP_POINTS = ["100%"];

const styles = StyleSheet.create((theme) => ({
  nativeDialogSurface: {
    flex: 1,
  },
  nativeDialogBackground: {
    backgroundColor: "transparent",
  },
  desktopOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    pointerEvents: "auto" as const,
  },
  desktopCard: {
    position: "relative",
    overflow: "hidden",
    width: "100%",
    maxWidth: 520,
    maxHeight: "85%",
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  headerContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  headerRow: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerBackButton: {
    borderRadius: theme.borderRadius.lg,
  },
  headerLeadingSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleGroup: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[SHEET_HEADER_CLOSE_PADDING_SCALE],
    borderRadius: theme.borderRadius.lg,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingBottom: theme.spacing[3],
  },
  // Inline variants for InlineHeaderView inside the desktop Combobox popover.
  // Horizontal padding matches the model picker's row indent: the picker uses
  // children mode (desktopChildrenScrollContent, no scroll padding), so the
  // row content starts at item.paddingHorizontal = spacing[3].
  // The search row below owns the gap under the title: the input already
  // carries its own vertical padding, so a paddingBottom here would stack on
  // top of two more and push the title far off the field.
  inlineHeaderRow: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inlineTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  desktopScrollContainer: {
    // Grows only when the card has an explicit `desktopHeight`; a content-sized
    // card has nothing to grow into. Without it a fixed-height card with short
    // content leaves the footer stranded in the middle.
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    position: "relative",
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  // The sheet's content inset — one definition for every presentation, always
  // applied through <SheetContent />.
  sheetContent: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
  },
  contentGrow: {
    flexGrow: 1,
  },
  compactStaticContent: {
    flex: 1,
    minHeight: 0,
  },
  bottomSheetVisibleScroll: {
    flex: 1,
    minHeight: 0,
  },
  desktopStaticContent: {
    flexShrink: 1,
    minHeight: 0,
  },
  footer: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  desktopResizableFooter: {
    paddingRight: 48,
  },
  desktopResizeHandle: {
    position: "absolute",
    right: theme.spacing[1],
    bottom: theme.spacing[1],
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    zIndex: 2,
  },
  desktopResizeGrip: {
    width: 12,
    height: 12,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: theme.colors.foregroundMuted,
  },
}));

const WEB_EXIT_DURATION_MS = 160;
const DESKTOP_RESIZE_MIN_WIDTH = 480;
const DESKTOP_RESIZE_MIN_HEIGHT = 360;
const DESKTOP_RESIZE_STEP = 24;
const DESKTOP_RESIZE_HANDLE_WEB_STYLE = {
  cursor: "nwse-resize",
  touchAction: "none",
  userSelect: "none",
} as object;

interface DesktopResizeSize {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface DesktopResizeLimits {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

function getDesktopPadding(
  style: CSSStyleDeclaration | null,
  side: "left" | "right" | "top" | "bottom",
) {
  const value = style?.getPropertyValue("padding-" + side) ?? "0";
  return Number.parseFloat(value) || 0;
}

function getDesktopResizeFrame(card: HTMLElement) {
  const overlay = card.parentElement;
  const overlayRect = overlay?.getBoundingClientRect() ?? null;
  const cardRect = card.getBoundingClientRect();
  const overlayStyle = overlay ? window.getComputedStyle(overlay) : null;
  const paddingLeft = getDesktopPadding(overlayStyle, "left");
  const paddingRight = getDesktopPadding(overlayStyle, "right");
  const paddingTop = getDesktopPadding(overlayStyle, "top");
  const paddingBottom = getDesktopPadding(overlayStyle, "bottom");
  const contentWidth = Math.max(
    0,
    (overlay?.clientWidth ?? window.innerWidth) - paddingLeft - paddingRight,
  );
  const contentHeight = Math.max(
    0,
    (overlay?.clientHeight ?? window.innerHeight) - paddingTop - paddingBottom,
  );

  return {
    left: overlayRect?.left ?? 0,
    right: overlayRect?.right ?? window.innerWidth,
    top: overlayRect?.top ?? 0,
    bottom: overlayRect?.bottom ?? window.innerHeight,
    cardRect,
    contentWidth,
    contentHeight,
    paddingLeft,
    paddingRight,
    paddingTop,
    paddingBottom,
  };
}

function getDesktopResizeLimits(
  card: HTMLElement,
  maxWidth: number,
  fitCentered = false,
): DesktopResizeLimits {
  if (!isWeb) return { minWidth: 0, maxWidth: 0, minHeight: 0, maxHeight: 0 };
  const frame = getDesktopResizeFrame(card);
  const centeredCardLeft =
    frame.left + frame.paddingLeft + (frame.contentWidth - frame.cardRect.width) / 2;
  const centeredCardTop =
    frame.top + frame.paddingTop + (frame.contentHeight - frame.cardRect.height) / 2;
  const availableWidth = Math.max(
    0,
    frame.right - frame.paddingRight - (fitCentered ? centeredCardLeft : frame.cardRect.left),
  );
  const availableHeight = Math.max(
    0,
    frame.bottom - frame.paddingBottom - (fitCentered ? centeredCardTop : frame.cardRect.top),
  );
  const boundedWidth = Math.min(maxWidth, availableWidth);
  const boundedHeight = Math.min(
    availableHeight,
    frame.contentHeight * 0.85,
    window.innerHeight * 0.85,
  );

  return {
    minWidth: Math.min(DESKTOP_RESIZE_MIN_WIDTH, boundedWidth),
    maxWidth: boundedWidth,
    minHeight: Math.min(DESKTOP_RESIZE_MIN_HEIGHT, boundedHeight),
    maxHeight: boundedHeight,
  };
}
function clampDesktopResizeSize(
  width: number,
  height: number,
  limits: DesktopResizeLimits,
): Pick<DesktopResizeSize, "width" | "height"> {
  return {
    width: Math.max(limits.minWidth, Math.min(width, limits.maxWidth)),
    height: Math.max(limits.minHeight, Math.min(height, limits.maxHeight)),
  };
}

function isDesktopResizeEnabled(resizable: boolean, isMobile: boolean) {
  return resizable && isWeb && !isMobile;
}

function getDesktopFooterStyle(resizable: boolean, footerContainerStyle: StyleProp<ViewStyle>) {
  return [styles.footer, resizable && styles.desktopResizableFooter, footerContainerStyle];
}

function getWebDesktopPortal(enabled: boolean, shouldRender: boolean, content: ReactNode) {
  if (!enabled || typeof document === "undefined") return undefined;
  if (!shouldRender) return null;
  return createPortal(content, getOverlayRoot());
}

function getDesktopCardStyle({
  desktopHeight,
  desktopMaxWidth,
  resizeEnabled,
  resizeSize,
  initialResizeWidth,
}: {
  desktopHeight?: DimensionValue;
  desktopMaxWidth?: number;
  resizeEnabled: boolean;
  resizeSize: DesktopResizeSize | null;
  initialResizeWidth: number;
}) {
  return [
    styles.desktopCard,
    desktopHeight != null && { height: desktopHeight },
    resizeEnabled
      ? {
          width: resizeSize?.width ?? initialResizeWidth,
          height: resizeSize?.height ?? desktopHeight,
          maxWidth: "100%" as const,
          transform: [
            { translateX: resizeSize?.offsetX ?? 0 },
            { translateY: resizeSize?.offsetY ?? 0 },
          ],
        }
      : desktopMaxWidth != null && { maxWidth: desktopMaxWidth },
  ];
}

function resizeDesktopSizeFromBase(
  width: number,
  height: number,
  base: DesktopResizeSize,
  limits: DesktopResizeLimits,
): DesktopResizeSize {
  const size = clampDesktopResizeSize(width, height, limits);
  return {
    ...size,
    offsetX: base.offsetX + (size.width - base.width) / 2,
    offsetY: base.offsetY + (size.height - base.height) / 2,
  };
}

function useDesktopResizeController({
  enabled,
  visible,
  maxWidth,
}: {
  enabled: boolean;
  visible: boolean;
  maxWidth: number;
}) {
  const [size, setSize] = useState<DesktopResizeSize | null>(null);
  const [limits, setLimits] = useState<DesktopResizeLimits | null>(null);
  const sizeRef = useRef<DesktopResizeSize | null>(null);
  const handleElementRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const setHandleElement = useCallback((element: unknown) => {
    handleElementRef.current = element as HTMLElement | null;
  }, []);

  const commitSize = useCallback(
    (width: number, height: number, base: DesktopResizeSize, nextLimits: DesktopResizeLimits) => {
      const next = resizeDesktopSizeFromBase(width, height, base, nextLimits);
      sizeRef.current = next;
      setSize(next);
      setLimits(nextLimits);
    },
    [],
  );

  useEffect(() => {
    if (!isWeb || !enabled || !visible) {
      cleanupRef.current?.();
      sizeRef.current = null;
      setSize(null);
      setLimits(null);
      return;
    }
    const card = handleElementRef.current?.parentElement;
    if (!card || sizeRef.current) return;
    const rect = card.getBoundingClientRect();
    const initial = { width: rect.width, height: rect.height, offsetX: 0, offsetY: 0 };
    sizeRef.current = initial;
    setSize(initial);
    setLimits(getDesktopResizeLimits(card, maxWidth));
  }, [enabled, maxWidth, visible]);

  useEffect(() => {
    if (!isWeb || !enabled || !visible) return;
    const card = handleElementRef.current?.parentElement;
    if (!card) return;

    const handleViewportResize = () => {
      cleanupRef.current?.();
      const nextLimits = getDesktopResizeLimits(card, maxWidth, true);
      const current = sizeRef.current;
      const rect = card.getBoundingClientRect();
      const nextSize = clampDesktopResizeSize(
        current?.width ?? rect.width,
        current?.height ?? rect.height,
        nextLimits,
      );
      const next = { ...nextSize, offsetX: 0, offsetY: 0 };
      sizeRef.current = next;
      setLimits(nextLimits);
      setSize(next);
    };

    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [enabled, maxWidth, visible]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback(
    (event: RNPointerEvent) => {
      if (!isWeb || !enabled || cleanupRef.current || event.nativeEvent.button > 0) return;
      const handle = event.currentTarget as unknown as HTMLElement;
      const card = handle.parentElement;
      if (!card) return;

      const rect = card.getBoundingClientRect();
      const current = sizeRef.current;
      const base = {
        width: rect.width,
        height: rect.height,
        offsetX: current?.offsetX ?? 0,
        offsetY: current?.offsetY ?? 0,
      };
      const nextLimits = getDesktopResizeLimits(card, maxWidth);
      setLimits(nextLimits);
      const pointerId = event.nativeEvent.pointerId;
      const startX = event.nativeEvent.clientX;
      const startY = event.nativeEvent.clientY;
      const cursorBefore = document.body.style.cursor;
      const userSelectBefore = document.body.style.userSelect;

      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture?.(pointerId);
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      function cleanup() {
        cleanupRef.current = null;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
        if (handle.hasPointerCapture?.(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
        document.body.style.cursor = cursorBefore;
        document.body.style.userSelect = userSelectBefore;
      }

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        commitSize(
          rect.width + moveEvent.clientX - startX,
          rect.height + moveEvent.clientY - startY,
          base,
          nextLimits,
        );
      }

      function handlePointerEnd(endEvent: PointerEvent) {
        if (endEvent.pointerId === pointerId) cleanup();
      }

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerEnd);
      window.addEventListener("pointercancel", handlePointerEnd);
    },
    [commitSize, enabled, maxWidth],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isWeb || !enabled) return;
      const card = (event.currentTarget as HTMLElement).parentElement;
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const current = sizeRef.current;
      const base = {
        width: rect.width,
        height: rect.height,
        offsetX: current?.offsetX ?? 0,
        offsetY: current?.offsetY ?? 0,
      };
      const nextLimits = getDesktopResizeLimits(card, maxWidth);
      let width = base.width;
      let height = base.height;
      const step = event.shiftKey ? DESKTOP_RESIZE_STEP * 4 : DESKTOP_RESIZE_STEP;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          width -= step;
          break;
        case "ArrowRight":
        case "ArrowUp":
          width += step;
          break;
        case "Home":
          width = nextLimits.minWidth;
          break;
        case "End":
          width = nextLimits.maxWidth;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      commitSize(width, height, base, nextLimits);
    },
    [commitSize, enabled, maxWidth],
  );

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (!isWeb || !enabled) return;
      const card = handleElementRef.current?.parentElement;
      if (!card) return;
      const action = event.nativeEvent.actionName;
      if (action !== "increment" && action !== "decrement") return;
      const rect = card.getBoundingClientRect();
      const current = sizeRef.current;
      const base = {
        width: rect.width,
        height: rect.height,
        offsetX: current?.offsetX ?? 0,
        offsetY: current?.offsetY ?? 0,
      };
      const nextLimits = getDesktopResizeLimits(card, maxWidth);
      const step = action === "increment" ? DESKTOP_RESIZE_STEP : -DESKTOP_RESIZE_STEP;
      commitSize(base.width + step, base.height, base, nextLimits);
    },
    [commitSize, enabled, maxWidth],
  );

  return { size, limits, setHandleElement, onPointerDown, onKeyDown, onAccessibilityAction };
}

function DesktopResizeHandle({
  enabled,
  title,
  testID,
  initialWidth,
  maxWidth,
  size,
  limits,
  setElementRef,
  onPointerDown,
  onKeyDown,
  onAccessibilityAction,
}: {
  enabled: boolean;
  title: string;
  testID?: string;
  initialWidth: number;
  maxWidth: number;
  size: DesktopResizeSize | null;
  limits: DesktopResizeLimits | null;
  setElementRef: (element: unknown) => void;
  onPointerDown: (event: RNPointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const accessibilityActions = useMemo(
    () => [
      { name: "decrement" as const, label: t("goals.form.decrease", { label: title }) },
      { name: "increment" as const, label: t("goals.form.increase", { label: title }) },
    ],
    [t, title],
  );
  const accessibilityValue = useMemo(
    () => ({
      min: limits?.minWidth ?? Math.min(DESKTOP_RESIZE_MIN_WIDTH, maxWidth),
      max: limits?.maxWidth ?? maxWidth,
      now: Math.round(size?.width ?? initialWidth),
    }),
    [initialWidth, limits, maxWidth, size],
  );

  if (!enabled) return null;

  return (
    <View
      ref={setElementRef}
      accessible
      focusable
      tabIndex={0}
      accessibilityRole="adjustable"
      accessibilityLabel={title}
      accessibilityValue={accessibilityValue}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      onPointerDown={onPointerDown}
      {...({ onKeyDown } as object)}
      style={[styles.desktopResizeHandle, DESKTOP_RESIZE_HANDLE_WEB_STYLE]}
      testID={testID}
    >
      <View style={styles.desktopResizeGrip} />
    </View>
  );
}
/** The compact sheet's surface: Gorhom's `backgroundComponent` for every bottom sheet. */
export function SheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  const combinedStyle = useMemo(
    () => [
      style,
      {
        backgroundColor: theme.colors.surface0,
        borderTopLeftRadius: theme.borderRadius["2xl"],
        borderTopRightRadius: theme.borderRadius["2xl"],
      },
    ],
    [style, theme.colors.surface0, theme.borderRadius],
  );
  return <Animated.View pointerEvents="none" style={combinedStyle} />;
}

const ThemedBottomSheetHandle = withUnistyles(BottomSheetHandle, (theme) => ({
  indicatorStyle: { backgroundColor: theme.colors.palette.zinc[600] },
}));

/** The compact sheet's drag handle: Gorhom's `handleComponent` for every bottom sheet. */
export function SheetHandle({
  // Gorhom passes `indicatorStyle={undefined}`, which would override the themed indicator.
  indicatorStyle: _indicatorStyle,
  ...props
}: ComponentProps<typeof BottomSheetHandle>) {
  return <ThemedBottomSheetHandle {...props} />;
}

/**
 * Content that drags the sheet the way its handle does. A sheet whose body scrolls on its own
 * turns content panning off and wraps its header in this, so the header still pulls it down.
 * Render it inside the sheet's content.
 */
export function SheetDragArea({ children }: { children: ReactNode }) {
  const { handlePanGestureHandler } = useBottomSheetGestureHandlers();
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .shouldCancelWhenOutside(false)
        .runOnJS(false)
        .onStart(handlePanGestureHandler.handleOnStart)
        .onChange(handlePanGestureHandler.handleOnChange)
        .onEnd(handlePanGestureHandler.handleOnEnd)
        .onFinalize(handlePanGestureHandler.handleOnFinalize),
    [handlePanGestureHandler],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View>{children}</View>
    </GestureDetector>
  );
}

/**
 * A compact sheet's content area that reaches the bottom of the screen. It owns the system
 * navigation inset: it pads it once and tells its content none is left, so content that pads the
 * inset itself, like the composer dock, sits the same in a sheet as in a tab.
 */
export function SheetBottomInset({ style, children, ...props }: ViewProps) {
  const insets = useSafeAreaInsets();
  const contentInsets = useMemo(() => ({ ...insets, bottom: 0 }), [insets]);
  const insetStyle = useMemo(() => [style, { paddingBottom: insets.bottom }], [style, insets]);
  return (
    <View {...props} style={insetStyle}>
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

/**
 * The sheet body, indented to the sheet's content inset.
 *
 * The inset lives on a real `View` and never on a scroller's
 * `contentContainerStyle`: that is a library prop, not the `style` prop
 * Unistyles registers, so a themed inset handed to a third-party scroller such
 * as `BottomSheetScrollView` silently resolves to nothing on web — which is how
 * the compact sheet ended up rendering its cards flush to the screen edges. See
 * docs/unistyles.md "Main Gotcha: contentContainerStyle".
 */
function SheetContent({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  return <View style={[styles.sheetContent, style]}>{children}</View>;
}

/**
 * An icon action in a sheet header's trailing rail, drawn like the Close button so a header's
 * actions line up with it at one size. Pass it through `SheetHeader.actions`.
 */
export function SheetHeaderIconButton({
  icon: Icon,
  accessibilityLabel,
  onPress,
  testID,
}: {
  icon: LucideIcon;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.closeButton}
      onPress={onPress}
      testID={testID}
    >
      {({ pressed }) => (
        <Icon size={16} color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

export function SheetHeaderView({
  header,
  onClose,
  showCloseButton = true,
  testID,
}: {
  header: SheetHeader;
  onClose: () => void;
  showCloseButton?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const back = header.back;
  const handleBackPress = back?.onPress;
  const search = header.search;
  const handleSearchChange = useCallback(
    (value: string) => {
      search?.onChange(value);
    },
    [search],
  );

  return (
    <View style={styles.headerContainer} testID={testID}>
      <View style={styles.headerRow}>
        {handleBackPress ? (
          <Pressable
            onPress={handleBackPress}
            hitSlop={8}
            style={styles.headerBackButton}
            accessibilityRole="button"
            accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")}
            testID="sheet-header-back"
          >
            {({ pressed }) => (
              <ArrowLeft
                size={18}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        ) : null}
        {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
        <View style={styles.headerTitleGroup}>
          <Text style={titleStyle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.subtitle}
        </View>
        {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        {showCloseButton ? (
          <SheetHeaderIconButton
            icon={X}
            accessibilityLabel={t("common.actions.close")}
            onPress={onClose}
          />
        ) : null}
      </View>
      {search ? (
        <View style={styles.searchRow}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={[styles.searchInput, isWeb && { outlineStyle: "none" }]}
            placeholder={search.placeholder ?? t("common.actions.search")}
            resetKey={search.resetKey}
            onChangeText={handleSearchChange}
            onFocus={search.onFocus}
            onBlur={search.onBlur}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={search.autoFocus}
            testID={search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export function InlineHeaderView({ header }: { header: SheetHeader }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const back = header.back;
  const handleBackPress = back?.onPress;
  const hasInlineRow = Boolean(handleBackPress || header.leading || header.actions);
  if (!hasInlineRow && !header.search) return null;
  return (
    <View>
      {hasInlineRow ? (
        <View style={styles.inlineHeaderRow}>
          {handleBackPress ? (
            <Pressable
              onPress={handleBackPress}
              hitSlop={8}
              style={styles.headerBackButton}
              accessibilityRole="button"
              accessibilityLabel={
                back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")
              }
              testID="sheet-header-back"
            >
              {({ pressed }) => (
                <ArrowLeft
                  size={16}
                  color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </Pressable>
          ) : null}
          {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
          <Text style={styles.inlineTitle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        </View>
      ) : null}
      {header.search ? (
        <View style={styles.inlineSearchRow}>
          <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={[styles.searchInput, isWeb && { outlineStyle: "none" }]}
            placeholder={header.search.placeholder ?? t("common.actions.search")}
            resetKey={header.search.resetKey}
            onChangeText={header.search.onChange}
            onFocus={header.search.onFocus}
            onBlur={header.search.onBlur}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={header.search.autoFocus}
            testID={header.search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export interface AdaptiveModalSheetProps {
  header: SheetHeader;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  children: ReactNode;
  /** Sticky footer rendered below the scrollable content. */
  footer?: ReactNode;
  footerContainerStyle?: StyleProp<ViewStyle>;
  snapPoints?: string[];
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /** Enable pointer and keyboard resizing of the desktop card. Compact sheets ignore this. */
  desktopResizable?: boolean;
  /** Starting width when desktop resizing is enabled. */
  desktopResizeInitialWidth?: number;
  /** Maximum width reached through desktop resizing. */
  desktopResizeMaxWidth?: number;
  /** Bound an author-owned list without changing content-sized first-party dialogs. */
  desktopHeight?: DimensionValue;
  /** Whether the host supplies the scroll container. Caller-owned lists still share sheet gestures. */
  scrollable?: boolean;
  presentation?: "push" | "replace";
  /** Full body viewport below the header, including space beyond the content. */
  bodyStyle?: StyleProp<ViewStyle>;
  /** Layout intent for the sheet body, composed over the sheet's own content inset. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Re-establishes caller-owned contexts inside the native or compact sheet portal. */
  contextBridge?: ContextBridge | null;
}

/**
 * The compact sheet's body. It renders on the far side of the sheet's portal so it reads the
 * screen's bottom inset, not the one left where the sheet was opened: inside a sheet tab, none is.
 */
function CompactSheetBody({
  header,
  onClose,
  testID,
  footer,
  isKeyboardVisible,
  scrollable,
  bodyStyle,
  contentStyle,
  children,
}: {
  header: SheetHeader;
  onClose: () => void;
  testID?: string;
  footer: ReactNode;
  isKeyboardVisible: boolean;
  scrollable: boolean;
  bodyStyle?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { contentPaddingBottom = 0, footerPaddingBottom = 0 } = getCompactSheetSafeAreaPadding({
    isCompact: true,
    isKeyboardVisible,
    hasFooter: Boolean(footer),
    safeAreaBottom: insets.bottom,
  });
  // Safe-area clearance is a separate layer: it must not replace the caller's
  // padding (including an explicit zero), and the footer owns it when present.
  const bodyClearanceStyle = { paddingBottom: contentPaddingBottom };
  const footerClearanceStyle = useMemo(
    () => ({ paddingBottom: footerPaddingBottom }),
    [footerPaddingBottom],
  );
  const footerView = useMemo(
    () => (footer ? <View style={footerClearanceStyle}>{footer}</View> : null),
    [footer, footerClearanceStyle],
  );
  return (
    <SheetVisibleFrame footer={footerView}>
      <SheetHeaderView header={header} onClose={onClose} testID={testID} />
      <View style={[styles.compactStaticContent, bodyStyle]}>
        {scrollable ? (
          <ScrollView
            style={styles.bottomSheetVisibleScroll}
            contentContainerStyle={SCROLL_CONTENT_GROW}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.contentGrow, bodyClearanceStyle]}>
              <SheetContent style={[styles.contentGrow, contentStyle]}>{children}</SheetContent>
            </View>
          </ScrollView>
        ) : (
          <View style={[styles.compactStaticContent, bodyClearanceStyle]}>
            <SheetContent style={[styles.compactStaticContent, contentStyle]}>
              {children}
            </SheetContent>
          </View>
        )}
      </View>
    </SheetVisibleFrame>
  );
}

export function AdaptiveModalSheet({
  header,
  visible,
  onClose,
  onDismiss,
  children,
  footer,
  footerContainerStyle,
  snapPoints,
  testID,
  desktopMaxWidth,
  desktopResizable = false,
  desktopResizeInitialWidth,
  desktopResizeMaxWidth,
  desktopHeight,
  scrollable = true,
  presentation,
  contentStyle,
  bodyStyle,
  contextBridge = null,
}: AdaptiveModalSheetProps) {
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const desktopResizeEnabled = isDesktopResizeEnabled(desktopResizable, isMobile);
  const configuredResizeMaxWidth = desktopResizeMaxWidth ?? desktopMaxWidth ?? 520;
  const initialResizeWidth = Math.min(
    desktopResizeInitialWidth ?? desktopMaxWidth ?? 520,
    configuredResizeMaxWidth,
  );
  const {
    size: desktopResizeSize,
    limits: desktopResizeLimits,
    setHandleElement: setResizeHandleElement,
    onPointerDown: handleDesktopResizePointerDown,
    onKeyDown: handleDesktopResizeKeyDown,
    onAccessibilityAction: handleDesktopResizeAccessibilityAction,
  } = useDesktopResizeController({
    enabled: desktopResizeEnabled,
    visible,
    maxWidth: configuredResizeMaxWidth,
  });
  const isKeyboardVisible = useKeyboardVisibility(visible);
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const footerView = useMemo(
    () =>
      footer ? (
        <View style={getDesktopFooterStyle(desktopResizeEnabled, footerContainerStyle)}>
          {footer}
        </View>
      ) : null,
    [desktopResizeEnabled, footer, footerContainerStyle],
  );
  useEffect(() => {
    if (!isWeb && visible) {
      // A newly opened sheet owns input. A keyboard belonging to the sheet below
      // would cover controls in the new sheet, which has no focused input yet.
      Keyboard.dismiss();
    }
  }, [visible]);

  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    isEnabled: isMobile || !isWeb,
    onClose,
  });
  const [shouldRenderWeb, setShouldRenderWeb] = useState(visible);
  const [isWebClosing, setIsWebClosing] = useState(false);
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && !isMobile && shouldRenderWeb);
  const handleDismiss = useCallback(() => {
    handleSheetDismiss();
    onDismiss?.();
  }, [handleSheetDismiss, onDismiss]);

  const desktopCardStyle = useMemo(
    () =>
      getDesktopCardStyle({
        desktopHeight,
        desktopMaxWidth,
        resizeEnabled: desktopResizeEnabled,
        resizeSize: desktopResizeSize,
        initialResizeWidth,
      }),
    [desktopHeight, desktopMaxWidth, desktopResizeEnabled, desktopResizeSize, initialResizeWidth],
  );
  const desktopOverlayStyle = useMemo(
    () => [
      styles.desktopOverlay,
      isWeb && {
        zIndex: modalLayer,
        opacity: isWebClosing ? 0 : 1,
        transitionDuration: `${WEB_EXIT_DURATION_MS}ms`,
        transitionProperty: "opacity",
        transitionTimingFunction: "ease",
      },
    ],
    [isWebClosing, modalLayer],
  );

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && !isMobile && visible,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  useEffect(() => {
    if (!isWeb || isMobile) return;
    if (visible) {
      setShouldRenderWeb(true);
      setIsWebClosing(false);
      return;
    }
    if (!shouldRenderWeb) return;
    setIsWebClosing(true);
    const timeout = window.setTimeout(() => {
      setShouldRenderWeb(false);
      setIsWebClosing(false);
      onDismiss?.();
    }, WEB_EXIT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [visible, isMobile, onDismiss, shouldRenderWeb]);

  if (isMobile) {
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        contextBridge={contextBridge}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        backdropOpacity={0.45}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleComponent={SheetHandle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
        presentation={presentation}
      >
        <CompactSheetBody
          header={header}
          onClose={onClose}
          testID={testID}
          footer={footerView}
          isKeyboardVisible={isKeyboardVisible}
          scrollable={scrollable}
          bodyStyle={bodyStyle}
          contentStyle={contentStyle}
        >
          {children}
        </CompactSheetBody>
      </IsolatedBottomSheetModal>
    );
  }

  const desktopStaticStyle =
    desktopHeight == null ? styles.desktopStaticContent : styles.compactStaticContent;
  const cardInner = (
    <OverlayLayerProvider layer={modalLayer}>
      <SheetHeaderView header={header} onClose={onClose} />
      <View style={[scrollable ? styles.desktopScrollContainer : desktopStaticStyle, bodyStyle]}>
        {scrollable ? (
          <ScrollView
            style={styles.desktopScroll}
            contentContainerStyle={SCROLL_CONTENT_GROW}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <SheetContent style={[styles.contentGrow, contentStyle]}>{children}</SheetContent>
          </ScrollView>
        ) : (
          <SheetContent style={[desktopStaticStyle, contentStyle]}>{children}</SheetContent>
        )}
      </View>
      {footerView}
    </OverlayLayerProvider>
  );

  const desktopContent = (
    <View style={desktopOverlayStyle} testID={testID}>
      <Pressable
        accessibilityLabel={t("common.actions.dismiss")}
        style={ABSOLUTE_FILL_STYLE}
        onPress={onClose}
      />
      <View
        ref={setWebOverlayScope}
        style={desktopCardStyle}
        role="dialog"
        aria-modal
        tabIndex={-1}
      >
        {cardInner}
        <DesktopResizeHandle
          enabled={desktopResizeEnabled}
          title={header.title}
          testID={testID ? testID + "-resize-handle" : undefined}
          initialWidth={initialResizeWidth}
          maxWidth={configuredResizeMaxWidth}
          size={desktopResizeSize}
          limits={desktopResizeLimits}
          setElementRef={setResizeHandleElement}
          onPointerDown={handleDesktopResizePointerDown}
          onKeyDown={handleDesktopResizeKeyDown}
          onAccessibilityAction={handleDesktopResizeAccessibilityAction}
        />
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  const webPortal = getWebDesktopPortal(isWeb, shouldRenderWeb, desktopContent);
  if (webPortal !== undefined) return webPortal;

  return (
    // Both native presentations share Gorhom's app-wide stack. Independent RN Modals
    // present from their React ancestor's controller, so a root-owned sibling dialog
    // cannot present while that controller already has a dialog open on iOS.
    <IsolatedBottomSheetModal
      ref={sheetRef}
      contextBridge={contextBridge}
      snapPoints={NATIVE_DIALOG_SNAP_POINTS}
      index={0}
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={handleDismiss}
      handleComponent={null}
      backgroundStyle={styles.nativeDialogBackground}
      enablePanDownToClose={false}
      enableHandlePanningGesture={false}
      enableContentPanningGesture={false}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      accessible={false}
      presentation={presentation}
    >
      <View style={styles.nativeDialogSurface}>{desktopContent}</View>
    </IsolatedBottomSheetModal>
  );
}
