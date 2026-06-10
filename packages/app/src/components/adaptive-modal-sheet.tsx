import { forwardRef, useCallback, useEffect, useMemo } from "react";
import type { ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { TextInputProps } from "react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getOverlayRoot, OVERLAY_Z } from "../lib/overlay-root";
import {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated from "react-native-reanimated";
import { ArrowLeft, Search, X } from "lucide-react-native";
import { FileDropZone } from "@/components/file-drop-zone";
import type { ImageAttachment } from "@/composer/types";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { getCompactSheetSafeAreaPadding } from "@/components/adaptive-modal-sheet-layout";
import { isNative, isWeb } from "@/constants/platform";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Horizontal indent token shared by the sheet header (title, back arrow,
// leading icon, search input icon) and any row primitive rendered inside the
// sheet body. Rows whose leading icon should line up with the header must
// match this padding.
export const SHEET_HORIZONTAL_PADDING_SCALE = 6;

export interface SheetHeaderSearch {
  onChange: (value: string) => void;
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

type EscHandler = () => void;
const escStack: EscHandler[] = [];
let escListenerAttached = false;
const ABSOLUTE_FILL_STYLE = { ...StyleSheet.absoluteFillObject };

function handleEscKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  const top = escStack[escStack.length - 1];
  if (!top) return;
  event.stopPropagation();
  event.preventDefault();
  top();
}

function pushEscHandler(handler: EscHandler): () => void {
  escStack.push(handler);
  if (!escListenerAttached && typeof window !== "undefined") {
    window.addEventListener("keydown", handleEscKeyDown, true);
    escListenerAttached = true;
  }
  return () => {
    const index = escStack.lastIndexOf(handler);
    if (index !== -1) escStack.splice(index, 1);
    if (escStack.length === 0 && escListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("keydown", handleEscKeyDown, true);
      escListenerAttached = false;
    }
  };
}

const styles = StyleSheet.create((theme) => ({
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    zIndex: OVERLAY_Z.modal,
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
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
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
  inlineHeaderRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopContent: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
    flexGrow: 1,
  },
  bottomSheetContent: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
  },
  bottomSheetStaticContent: {
    flex: 1,
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
    minHeight: 0,
  },
  desktopStaticContent: {
    flexShrink: 1,
    minHeight: 0,
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
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
    outlineColor: theme.colors.accent,
  },
  adaptiveInputText: {
    color: theme.colors.foreground,
  },
  adaptiveInputPlaceholder: {
    color: theme.colors.foregroundMuted,
  },
}));

const SEARCH_INPUT_STYLE = [styles.searchInput, isWeb && { outlineStyle: "none" }];

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
            accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? "Back"}
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
          <Pressable accessibilityLabel="Close" style={styles.closeButton} onPress={onClose}>
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
            style={SEARCH_INPUT_STYLE}
            placeholder={search.placeholder ?? "Search"}
            resetKey={search.resetKey}
            onChangeText={handleSearchChange}
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
              accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? "Back"}
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
            style={SEARCH_INPUT_STYLE}
            placeholder={header.search.placeholder ?? "Search"}
            resetKey={header.search.resetKey}
            onChangeText={header.search.onChange}
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
  children: ReactNode;
  /** Sticky footer rendered below the scrollable content. */
  footer?: ReactNode;
  snapPoints?: string[];
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /** When provided, wraps the card content in a FileDropZone. */
  onFilesDropped?: (files: ImageAttachment[]) => void;
  scrollable?: boolean;
  presentation?: "push" | "replace";
}

export function AdaptiveModalSheet({
  header,
  visible,
  onClose,
  children,
  footer,
  snapPoints,
  testID,
  desktopMaxWidth,
  onFilesDropped,
  scrollable = true,
  presentation,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const compactSafeAreaPadding = useMemo(
    () =>
      getCompactSheetSafeAreaPadding({
        isCompact: isMobile,
        hasFooter: Boolean(footer),
        baseContentPadding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
        baseFooterPadding: theme.spacing[3],
        safeAreaBottom: insets.bottom,
      }),
    [footer, insets.bottom, isMobile, theme.spacing],
  );
  const bottomSheetContentStyle = useMemo(
    () => [
      styles.bottomSheetContent,
      compactSafeAreaPadding.contentPaddingBottom != null
        ? { paddingBottom: compactSafeAreaPadding.contentPaddingBottom }
        : null,
    ],
    [compactSafeAreaPadding.contentPaddingBottom],
  );
  const bottomSheetStaticContentStyle = useMemo(
    () => [
      styles.bottomSheetStaticContent,
      compactSafeAreaPadding.contentPaddingBottom != null
        ? { paddingBottom: compactSafeAreaPadding.contentPaddingBottom }
        : null,
    ],
    [compactSafeAreaPadding.contentPaddingBottom],
  );
  const footerStyle = useMemo(
    () => [
      styles.footer,
      compactSafeAreaPadding.footerPaddingBottom != null
        ? { paddingBottom: compactSafeAreaPadding.footerPaddingBottom }
        : null,
    ],
    [compactSafeAreaPadding.footerPaddingBottom],
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

  useEffect(() => {
    if (!isWeb || isMobile || !visible) return;
    return pushEscHandler(onClose);
  }, [visible, isMobile, onClose]);

  if (isMobile) {
    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleSheetDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={handleIndicatorStyle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
        presentation={presentation}
      >
        <SheetHeaderView header={header} onClose={onClose} testID={testID} />
        {scrollable ? (
          <BottomSheetScrollView
            contentContainerStyle={bottomSheetContentStyle}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </BottomSheetScrollView>
        ) : (
          <View style={bottomSheetStaticContentStyle}>{children}</View>
        )}
        {footer ? <View style={footerStyle}>{footer}</View> : null}
      </IsolatedBottomSheetModal>
    );
  }

  const cardInner = (
    <>
      <SheetHeaderView header={header} onClose={onClose} />
      {scrollable ? (
        <ScrollView
          style={styles.desktopScroll}
          contentContainerStyle={styles.desktopContent}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.desktopStaticContent}>{children}</View>
      )}
      {footer ? <View style={footerStyle}>{footer}</View> : null}
    </>
  );

  const desktopContent = (
    <View style={styles.desktopOverlay} testID={testID}>
      <Pressable accessibilityLabel="Dismiss" style={ABSOLUTE_FILL_STYLE} onPress={onClose} />
      <View style={desktopCardStyle}>
        {onFilesDropped ? (
          <FileDropZone onFilesDropped={onFilesDropped}>{cardInner}</FileDropZone>
        ) : (
          cardInner
        )}
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!visible) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      hardwareAccelerated
    >
      {desktopContent}
    </Modal>
  );
}
