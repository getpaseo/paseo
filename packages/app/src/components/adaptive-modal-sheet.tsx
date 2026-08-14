import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "../lib/overlay-root";
import {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  KEYBOARD_STATUS,
  useBottomSheetInternal,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { ArrowLeft, Search, X } from "lucide-react-native";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  getBottomSheetVisibleContentHeight,
  getCompactSheetSafeAreaPadding,
} from "@/components/adaptive-modal-sheet-layout";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { isNative, isWeb } from "@/constants/platform";
import { useKeyboardVisibility } from "@/hooks/use-keyboard-visibility";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Horizontal indent token shared by the sheet header (title, back arrow,
// leading icon, search input icon) and any row primitive rendered inside the
// sheet body. Rows whose leading icon should line up with the header must
// match this padding.
export const SHEET_HORIZONTAL_PADDING_SCALE = 6;

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

const ABSOLUTE_FILL_STYLE = { ...StyleSheet.absoluteFillObject };

const styles = StyleSheet.create((theme) => ({
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    pointerEvents: "auto" as const,
  },
  desktopCard: {
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
  // No padding: it would inset the glyph from the header's right rail, where the title, the search
  // icon and everything the sheet renders below sit flush. The target comes from `hitSlop`, the
  // way the back arrow on the other rail already gets its own.
  closeButton: {
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
  bottomSheetVisibleContent: {
    minHeight: 0,
    overflow: "hidden",
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
  adaptiveInputOutline: {
    ...createControlGeometry(theme).controlFocusRingColor,
  },
  adaptiveInputText: {
    color: theme.colors.foreground,
  },
  adaptiveInputPlaceholder: {
    color: theme.colors.foregroundMuted,
  },
}));

const WEB_EXIT_DURATION_MS = 160;

function SheetBackground({ style }: BottomSheetBackgroundProps) {
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

function BottomSheetVisibleContent({ children }: { children: ReactNode }) {
  const { animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition } =
    useBottomSheetInternal();
  const visibleContentStyle = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    if (containerHeight < 0 || handleHeight < 0) {
      return { height: 0 };
    }

    const initialDetentPosition = animatedDetentsState.get().detents?.[0];
    const contentPosition =
      initialDetentPosition == null
        ? animatedPosition.get()
        : Math.min(animatedPosition.get(), initialDetentPosition);

    const keyboardState = animatedKeyboardState.get();
    return {
      height: getBottomSheetVisibleContentHeight({
        containerHeight,
        contentPosition,
        handleHeight,
        keyboardHeight: keyboardState.heightWithinContainer,
        isKeyboardVisible: keyboardState.status === KEYBOARD_STATUS.SHOWN,
      }),
    };
  }, [animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition]);

  return (
    <Animated.View style={[styles.bottomSheetVisibleContent, visibleContentStyle]}>
      {children}
    </Animated.View>
  );
}

export type AdaptiveTextInputProps = TextInputProps & {
  initialValue?: string;
  resetKey?: string | number;
};

// React Native controlled TextInput can replay stale JS values during fast input
// and visibly flicker/cursor-jump. Keep the rendered text native-owned; callers
// can seed it once with initialValue and remount with resetKey for real resets.
// See https://github.com/facebook/react-native/issues/44157
//
// Text color and placeholder color are owned by this leaf — not the caller.
// `@gorhom/bottom-sheet` mounts header subtrees before the sheet is visible
// under whatever theme is active at mount time, then keeps them mounted across
// theme changes; any caller that paints color via `StyleSheet.create((theme) =>
// ...)` from outside this leaf ends up with stale colors in dark mode (see
// docs/unistyles.md "Hidden Sheet Content"). withUnistyles wraps the actual
// TextInput so theme-driven re-renders land on the wrapper.
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ThemedBottomSheetTextInput = withUnistyles(BottomSheetTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export const AdaptiveTextInput = forwardRef<TextInput, AdaptiveTextInputProps>(
  function AdaptiveTextInputInner(props, ref) {
    const isMobile = useIsCompactFormFactor();
    const { value: _value, initialValue, resetKey, defaultValue, style, ...inputProps } = props;
    // Leaf-owned color goes LAST so callers cannot override it with a stale
    // theme read. Outline color is theme-aware on web :focus-visible.
    const textInputProps = {
      ...inputProps,
      defaultValue: initialValue ?? defaultValue,
      style: [styles.adaptiveInputOutline, style, styles.adaptiveInputText],
    };

    if (isMobile && isNative) {
      return (
        <ThemedBottomSheetTextInput
          key={resetKey}
          ref={ref as unknown as Ref<never>}
          {...textInputProps}
        />
      );
    }
    return <ThemedTextInput key={resetKey} ref={ref} {...textInputProps} />;
  },
);

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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            hitSlop={8}
            style={styles.closeButton}
            onPress={onClose}
          >
            {({ pressed }) => (
              <X
                size={16}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
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
  scrollable?: boolean;
  presentation?: "push" | "replace";
  /** Layout intent for the sheet body, composed over the sheet's own content inset. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Size compact sheet content to the live snap height instead of its largest snap point. */
  sizeContentToCurrentSnapPoint?: boolean;
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
  scrollable = true,
  presentation,
  contentStyle,
  sizeContentToCurrentSnapPoint = false,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardVisibility();
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const compactSafeAreaPadding = useMemo(
    () =>
      getCompactSheetSafeAreaPadding({
        isCompact: isMobile,
        isKeyboardVisible,
        hasFooter: Boolean(footer),
        baseContentPadding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
        baseFooterPadding: theme.spacing[3],
        safeAreaBottom: insets.bottom,
      }),
    [footer, insets.bottom, isKeyboardVisible, isMobile, theme.spacing],
  );
  const compactContentStyle = useMemo(
    () => [
      contentStyle,
      compactSafeAreaPadding.contentPaddingBottom != null
        ? { paddingBottom: compactSafeAreaPadding.contentPaddingBottom }
        : null,
    ],
    [compactSafeAreaPadding.contentPaddingBottom, contentStyle],
  );
  const compactStaticContentStyle = useMemo(
    () => [styles.compactStaticContent, compactContentStyle],
    [compactContentStyle],
  );
  const desktopScrollContentStyle = useMemo(
    () => [styles.contentGrow, contentStyle],
    [contentStyle],
  );
  const desktopStaticContentStyle = useMemo(
    () => [styles.desktopStaticContent, contentStyle],
    [contentStyle],
  );
  const footerStyle = useMemo(
    () => [
      styles.footer,
      footerContainerStyle,
      compactSafeAreaPadding.footerPaddingBottom != null
        ? { paddingBottom: compactSafeAreaPadding.footerPaddingBottom }
        : null,
    ],
    [compactSafeAreaPadding.footerPaddingBottom, footerContainerStyle],
  );
  const handleIndicatorStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    isEnabled: isMobile,
    onClose,
  });
  const [shouldRenderWeb, setShouldRenderWeb] = useState(visible);
  const [isWebClosing, setIsWebClosing] = useState(false);
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && !isMobile && shouldRenderWeb);
  const nativeModalDismissNotifiedRef = useRef(!visible);
  const handleDismiss = useCallback(() => {
    handleSheetDismiss();
    onDismiss?.();
  }, [handleSheetDismiss, onDismiss]);
  const notifyNativeModalDismiss = useCallback(() => {
    if (nativeModalDismissNotifiedRef.current) {
      return;
    }
    nativeModalDismissNotifiedRef.current = true;
    onDismiss?.();
  }, [onDismiss]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  const desktopCardStyle = useMemo(
    () => [styles.desktopCard, desktopMaxWidth != null && { maxWidth: desktopMaxWidth }],
    [desktopMaxWidth],
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
    if (visible) {
      nativeModalDismissNotifiedRef.current = false;
    }
  }, [visible]);

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

  useEffect(() => {
    if (isWeb || isMobile || visible || Platform.OS !== "android") return;
    const timeout = setTimeout(notifyNativeModalDismiss, 0);
    return () => clearTimeout(timeout);
  }, [visible, isMobile, notifyNativeModalDismiss]);

  if (isMobile) {
    const sheetContent = (
      <>
        <SheetHeaderView header={header} onClose={onClose} testID={testID} />
        {scrollable ? (
          <BottomSheetScrollView
            style={sizeContentToCurrentSnapPoint ? styles.bottomSheetVisibleScroll : undefined}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <SheetContent style={compactContentStyle}>{children}</SheetContent>
          </BottomSheetScrollView>
        ) : (
          <SheetContent style={compactStaticContentStyle}>{children}</SheetContent>
        )}
        {footer ? <View style={footerStyle}>{footer}</View> : null}
      </>
    );

    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        contextBridge={null}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={handleIndicatorStyle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
        presentation={presentation}
      >
        {sizeContentToCurrentSnapPoint ? (
          <BottomSheetVisibleContent>{sheetContent}</BottomSheetVisibleContent>
        ) : (
          sheetContent
        )}
      </IsolatedBottomSheetModal>
    );
  }

  const cardInner = (
    <OverlayLayerProvider layer={modalLayer}>
      <SheetHeaderView header={header} onClose={onClose} />
      {scrollable ? (
        <View style={styles.desktopScrollContainer}>
          <ScrollView
            style={styles.desktopScroll}
            contentContainerStyle={styles.contentGrow}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <SheetContent style={desktopScrollContentStyle}>{children}</SheetContent>
          </ScrollView>
        </View>
      ) : (
        <SheetContent style={desktopStaticContentStyle}>{children}</SheetContent>
      )}
      {footer ? <View style={footerStyle}>{footer}</View> : null}
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
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!shouldRenderWeb) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      onDismiss={notifyNativeModalDismiss}
      hardwareAccelerated
    >
      {desktopContent}
    </Modal>
  );
}
