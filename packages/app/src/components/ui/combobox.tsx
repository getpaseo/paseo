import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  Modal,
  TextInput,
  ScrollView,
  Platform,
  StatusBar,
  useWindowDimensions,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetTextInput,
  BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Check, File, Folder, Search } from "lucide-react-native";
import {
  flip,
  offset as floatingOffset,
  shift,
  size as floatingSize,
  useFloating,
} from "@floating-ui/react-native";
import { getNextActiveIndex } from "./combobox-keyboard";
import {
  buildVisibleComboboxOptions,
  getComboboxFallbackIndex,
  orderVisibleComboboxOptions,
  shouldShowCustomComboboxOption,
} from "./combobox-options";
import type { ComboboxOptionModel } from "./combobox-options";
import { isWeb } from "@/constants/platform";

const IS_WEB = isWeb;

export type ComboboxOption = ComboboxOptionModel;

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onSelect: (id: string) => void;
  renderOption?: (input: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
  onSearchQueryChange?: (query: string) => void;
  searchable?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustomValue?: boolean;
  customValuePrefix?: string;
  customValueDescription?: string;
  customValueKind?: "directory" | "file";
  optionsPosition?: "below-search" | "above-search";
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  enableDismissOnClose?: boolean;
  stackBehavior?: "push" | "switch" | "replace";
  desktopPlacement?: "top-start" | "bottom-start";
  /**
   * Prevents an initial frame at 0,0 by hiding desktop content until floating
   * coordinates resolve. This intentionally disables fade enter/exit animation
   * for that combobox instance to avoid animation overriding hidden opacity.
   */
  desktopPreventInitialFlash?: boolean;
  /** Minimum width for the desktop popover (overrides trigger-based width). */
  desktopMinWidth?: number;
  /** Fixed height for the desktop popover (overrides default 400px max). */
  desktopFixedHeight?: number;
  /** Content rendered above the scroll area on desktop (sticky header). */
  stickyHeader?: ReactNode;
  /** When true, selecting an option does not close the picker (multi-select mode). */
  keepOpenOnSelect?: boolean;
  anchorRef: React.RefObject<View | null>;
  children?: ReactNode;
}

function toNumericStyleValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function ComboboxSheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        style,
        {
          backgroundColor: theme.colors.surface0,
          borderTopLeftRadius: theme.borderRadius["2xl"],
          borderTopRightRadius: theme.borderRadius["2xl"],
        },
      ]}
    />
  );
}

export interface SearchInputProps {
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
  useBottomSheetInput?: boolean;
}

export function SearchInput({
  placeholder,
  value,
  onChangeText,
  onSubmitEditing,
  autoFocus = false,
  useBottomSheetInput = false,
}: SearchInputProps): ReactElement {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInput>(null);
  const InputComponent = useBottomSheetInput ? BottomSheetTextInput : TextInput;

  useEffect(() => {
    if (autoFocus && IS_WEB && inputRef.current) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  return (
    <View style={styles.searchInputContainer}>
      <Search size={16} color={theme.colors.foregroundMuted} />
      <InputComponent
        ref={inputRef as any}
        // @ts-expect-error - outlineStyle is web-only
        style={[styles.searchInput, IS_WEB && { outlineStyle: "none" }]}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={onSubmitEditing}
      />
    </View>
  );
}

export interface ComboboxItemProps {
  label: string;
  description?: string;
  kind?: "directory" | "file";
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  selected?: boolean;
  active?: boolean;
  disabled?: boolean;
  /** When true, bumps hover/pressed colors up one surface level (for items on elevated backgrounds). */
  elevated?: boolean;
  onPress: () => void;
  testID?: string;
}

export function ComboboxItem({
  label,
  description,
  kind,
  leadingSlot,
  trailingSlot,
  selected,
  active,
  disabled,
  elevated,
  onPress,
  testID,
}: ComboboxItemProps): ReactElement {
  const { theme } = useUnistyles();

  const leadingContent = leadingSlot ? (
    <View style={styles.comboboxItemLeadingSlot}>{leadingSlot}</View>
  ) : kind === "directory" || kind === "file" ? (
    <View style={styles.comboboxItemLeadingSlot}>
      {kind === "directory" ? (
        <Folder size={16} color={theme.colors.foregroundMuted} />
      ) : (
        <File size={16} color={theme.colors.foregroundMuted} />
      )}
    </View>
  ) : null;

  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered = false }) => [
        styles.comboboxItem,
        hovered && (elevated ? styles.comboboxItemHoveredElevated : styles.comboboxItemHovered),
        pressed && (elevated ? styles.comboboxItemPressedElevated : styles.comboboxItemPressed),
        active && styles.comboboxItemActive,
        disabled && styles.comboboxItemDisabled,
      ]}
    >
      {leadingContent}
      <View style={[styles.comboboxItemContent, description && styles.comboboxItemContentInline]}>
        <Text numberOfLines={1} style={styles.comboboxItemLabel}>
          {label}
        </Text>
        {description ? (
          <Text numberOfLines={1} style={styles.comboboxItemDescription}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected || trailingSlot ? (
        <View style={styles.comboboxItemTrailingContainer}>
          <View style={styles.comboboxItemTrailingSlot}>
            {selected ? <Check size={16} color={theme.colors.foregroundMuted} /> : null}
          </View>
          {trailingSlot}
        </View>
      ) : null}
    </Pressable>
  );
}

export function ComboboxEmpty({ children }: { children: ReactNode }): ReactElement {
  return (
    <Text testID="combobox-empty-text" style={styles.emptyText}>
      {children}
    </Text>
  );
}

export function Combobox({
  options,
  value,
  onSelect,
  renderOption,
  onSearchQueryChange,
  searchable = true,
  placeholder = "Search...",
  searchPlaceholder,
  emptyText = "No options match your search.",
  allowCustomValue = false,
  customValuePrefix = "Use",
  customValueDescription,
  customValueKind,
  optionsPosition = "below-search",
  title = "Select",
  open,
  onOpenChange,
  enableDismissOnClose,
  stackBehavior,
  desktopPlacement = "top-start",
  desktopPreventInitialFlash = true,
  desktopMinWidth,
  desktopFixedHeight,
  stickyHeader,
  keepOpenOnSelect = false,
  anchorRef,
  children,
}: ComboboxProps): ReactElement {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const effectiveOptionsPosition = isMobile ? "below-search" : optionsPosition;
  const isDesktopAboveSearch = !isMobile && isWeb && effectiveOptionsPosition === "above-search";
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const hasPresentedBottomSheetRef = useRef(false);
  const snapPoints = useMemo(() => ["60%", "90%"], []);
  const [availableSize, setAvailableSize] = useState<{ width?: number; height?: number } | null>(
    null,
  );
  const [referenceWidth, setReferenceWidth] = useState<number | null>(null);
  const [referenceLeft, setReferenceLeft] = useState<number | null>(null);
  const [referenceTop, setReferenceTop] = useState<number | null>(null);
  const [referenceAtOrigin, setReferenceAtOrigin] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const desktopOptionsScrollRef = useRef<ScrollView>(null);
  const [desktopContentWidth, setDesktopContentWidth] = useState<number | null>(null);

  const isControlled = typeof open === "boolean";
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = isControlled ? open : internalOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  const setSearchQueryWithCallback = useCallback(
    (nextQuery: string) => {
      setSearchQuery(nextQuery);
      onSearchQueryChange?.(nextQuery);
    },
    [onSearchQueryChange],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    setSearchQueryWithCallback("");
  }, [setOpen, setSearchQueryWithCallback]);

  useEffect(() => {
    if (isOpen) {
      setSearchQueryWithCallback("");
    }
  }, [isOpen, setSearchQueryWithCallback]);

  const collisionPadding = useMemo(() => {
    const basePadding = 16;
    if (Platform.OS !== "android") return basePadding;
    const statusBarHeight = StatusBar.currentHeight ?? 0;
    return Math.max(basePadding, statusBarHeight + basePadding);
  }, []);

  const middleware = useMemo(
    () => [
      floatingOffset(isWeb ? 5 : 4),
      ...(isWeb ? [] : [flip({ padding: collisionPadding })]),
      ...(isDesktopAboveSearch ? [] : [shift({ padding: collisionPadding })]),
      floatingSize({
        padding: collisionPadding,
        apply({ availableWidth, availableHeight, rects }) {
          setAvailableSize((prev) => {
            const next = { width: availableWidth, height: availableHeight };
            if (!prev) return next;
            if (prev.width === next.width && prev.height === next.height) return prev;
            return next;
          });
          setReferenceWidth((prev) => {
            const next = rects.reference.width;
            if (!(next > 0)) {
              return prev;
            }
            if (prev === next) return prev;
            return next;
          });
        },
      }),
    ],
    [collisionPadding, isDesktopAboveSearch],
  );

  const { refs, floatingStyles, update } = useFloating({
    placement: isWeb ? desktopPlacement : "bottom-start",
    middleware,
    sameScrollView: false,
    elements: {
      reference: anchorRef.current ?? undefined,
    },
  });

  useEffect(() => {
    if (!isOpen || isMobile) {
      setAvailableSize(null);
      setDesktopContentWidth(null);
      setReferenceLeft(null);
      setReferenceWidth(null);
      return;
    }
    const raf = requestAnimationFrame(() => void update());
    return () => cancelAnimationFrame(raf);
  }, [desktopPlacement, isMobile, isOpen, update]);

  useEffect(() => {
    if (!isOpen || isMobile) {
      setReferenceLeft(null);
      setReferenceAtOrigin(false);
      setReferenceTop(null);
      return;
    }

    const referenceEl = anchorRef.current;
    if (!referenceEl) {
      setReferenceAtOrigin(false);
      setReferenceTop(null);
      return;
    }

    const measure = () => {
      referenceEl.measureInWindow((x, y, width, height) => {
        setReferenceLeft((prev) => (prev === x ? prev : x));
        setReferenceAtOrigin(Math.abs(x) <= 1 && Math.abs(y) <= 1);
        setReferenceTop((prev) => (prev === y ? prev : y));
        setReferenceWidth((prev) => {
          if (!(width > 0)) {
            return prev;
          }
          return prev === width ? prev : width;
        });
      });
    };

    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [anchorRef, isMobile, isOpen, searchQuery, windowHeight]);

  const floatingTop = toNumericStyleValue(floatingStyles.top);
  const floatingLeft = toNumericStyleValue(floatingStyles.left);
  const desktopAboveSearchBottom =
    isDesktopAboveSearch && referenceTop !== null
      ? Math.max(windowHeight - referenceTop, collisionPadding)
      : null;
  const hasNonZeroFloatingPosition = (floatingTop ?? 0) !== 0 || floatingLeft !== 0;
  const useMeasuredTopStartPosition =
    !isDesktopAboveSearch &&
    IS_WEB &&
    !isMobile &&
    desktopPlacement === "top-start" &&
    referenceTop !== null &&
    referenceLeft !== null &&
    desktopContentWidth !== null;
  const clampedMeasuredTopStartLeft = useMeasuredTopStartPosition
    ? Math.max(
        collisionPadding,
        Math.min(windowWidth - desktopContentWidth - collisionPadding, referenceLeft),
      )
    : null;
  const measuredTopStartBottom = useMeasuredTopStartPosition
    ? Math.max(windowHeight - referenceTop + 5, collisionPadding)
    : null;
  const hasResolvedDesktopPosition =
    referenceWidth !== null &&
    referenceWidth > 0 &&
    (isDesktopAboveSearch
      ? floatingLeft !== null && desktopAboveSearchBottom !== null
      : useMeasuredTopStartPosition
        ? clampedMeasuredTopStartLeft !== null && measuredTopStartBottom !== null
        : floatingLeft !== null &&
          floatingTop !== null &&
          (hasNonZeroFloatingPosition || referenceAtOrigin));
  const shouldHideDesktopContent = desktopPreventInitialFlash && !hasResolvedDesktopPosition;
  const shouldUseDesktopFade = !desktopPreventInitialFlash;

  const desktopPositionStyle = isDesktopAboveSearch
    ? {
        left: floatingLeft ?? 0,
        bottom: desktopAboveSearchBottom ?? 0,
      }
    : useMeasuredTopStartPosition
      ? {
          left: clampedMeasuredTopStartLeft ?? 0,
          bottom: measuredTopStartBottom ?? 0,
        }
      : floatingStyles;

  useEffect(() => {
    if (!isMobile) return;
    if (isOpen) {
      if (enableDismissOnClose === false && hasPresentedBottomSheetRef.current) {
        bottomSheetRef.current?.snapToIndex(0);
      } else {
        hasPresentedBottomSheetRef.current = true;
        bottomSheetRef.current?.present();
      }
    } else {
      if (enableDismissOnClose === false) {
        bottomSheetRef.current?.close();
      } else {
        bottomSheetRef.current?.dismiss();
      }
    }
  }, [enableDismissOnClose, isOpen, isMobile]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        handleClose();
      }
    },
    [handleClose],
  );

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  const normalizedSearch = searchable ? searchQuery.trim().toLowerCase() : "";
  const sanitizedSearchValue = searchQuery.trim();
  const showCustomOption = useMemo(
    () =>
      shouldShowCustomComboboxOption({
        options,
        searchQuery,
        searchable,
        allowCustomValue,
      }),
    [allowCustomValue, options, searchQuery, searchable],
  );

  const visibleOptions = useMemo(
    () =>
      buildVisibleComboboxOptions({
        options,
        searchQuery,
        searchable,
        allowCustomValue,
        customValuePrefix,
        customValueDescription,
        customValueKind,
      }),
    [
      allowCustomValue,
      customValueDescription,
      customValueKind,
      customValuePrefix,
      options,
      searchQuery,
      searchable,
    ],
  );

  const orderedVisibleOptions = useMemo(
    () => orderVisibleComboboxOptions(visibleOptions, effectiveOptionsPosition),
    [effectiveOptionsPosition, visibleOptions],
  );

  const pinDesktopOptionsToBottom = useCallback(() => {
    if (isMobile || effectiveOptionsPosition !== "above-search") {
      return;
    }
    desktopOptionsScrollRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(() => {
      desktopOptionsScrollRef.current?.scrollToEnd({ animated: false });
    });
  }, [effectiveOptionsPosition, isMobile]);

  const handleDesktopOptionsContentSizeChange = useCallback(() => {
    if (!isOpen) {
      return;
    }
    pinDesktopOptionsToBottom();
  }, [isOpen, pinDesktopOptionsToBottom]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    pinDesktopOptionsToBottom();
  }, [isOpen, orderedVisibleOptions, pinDesktopOptionsToBottom]);

  useLayoutEffect(() => {
    if (!isOpen || isMobile) {
      return;
    }
    void update();
  }, [isOpen, isMobile, orderedVisibleOptions.length, searchQuery, update]);

  useEffect(() => {
    if (!isOpen) return;
    if (!IS_WEB && isMobile) return;

    if (orderedVisibleOptions.length === 0) {
      setActiveIndex(-1);
      return;
    }

    const fallbackIndex = getComboboxFallbackIndex(
      orderedVisibleOptions.length,
      effectiveOptionsPosition,
    );

    if (normalizedSearch) {
      setActiveIndex(fallbackIndex);
      return;
    }

    const selectedIndex = orderedVisibleOptions.findIndex((opt) => opt.id === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
  }, [effectiveOptionsPosition, isMobile, isOpen, normalizedSearch, value, orderedVisibleOptions]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      if (!keepOpenOnSelect) {
        handleClose();
      }
    },
    [handleClose, keepOpenOnSelect, onSelect],
  );

  const handleSubmitSearch = useCallback(() => {
    if (showCustomOption) {
      handleSelect(sanitizedSearchValue);
    }
  }, [handleSelect, sanitizedSearchValue, showCustomOption]);

  const handleDesktopKey = useCallback(
    (key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape", event?: KeyboardEvent) => {
      if (!isOpen) return;
      if (!IS_WEB && isMobile) return;

      if (key === "ArrowDown" || key === "ArrowUp") {
        event?.preventDefault();
        setActiveIndex((currentIndex) =>
          getNextActiveIndex({
            currentIndex,
            itemCount: orderedVisibleOptions.length,
            key,
          }),
        );
        return;
      }

      if (key === "Enter") {
        if (orderedVisibleOptions.length === 0) return;
        event?.preventDefault();
        const index =
          activeIndex >= 0 && activeIndex < orderedVisibleOptions.length ? activeIndex : 0;
        handleSelect(orderedVisibleOptions[index]!.id);
        return;
      }

      if (key === "Escape") {
        event?.preventDefault();
        handleClose();
      }
    },
    [activeIndex, handleClose, handleSelect, isMobile, isOpen, orderedVisibleOptions],
  );

  useEffect(() => {
    if (!IS_WEB || !isOpen) return;

    const handler = (event: KeyboardEvent) => {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") {
        return;
      }
      handleDesktopKey(key, event);
    };

    // react-native-web's TextInput can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
    };
  }, [handleDesktopKey, isOpen]);

  const searchInput = (
    <SearchInput
      placeholder={searchPlaceholder ?? placeholder}
      value={searchQuery}
      onChangeText={setSearchQueryWithCallback}
      onSubmitEditing={handleSubmitSearch}
      autoFocus={!isMobile}
      useBottomSheetInput={isMobile}
    />
  );

  const optionsList = (
    <>
      {orderedVisibleOptions.length > 0 ? (
        orderedVisibleOptions.map((opt, index) =>
          renderOption ? (
            <View key={opt.id}>
              {renderOption({
                option: opt,
                selected: opt.id === value,
                active: index === activeIndex,
                onPress: () => handleSelect(opt.id),
              })}
            </View>
          ) : (
            <ComboboxItem
              key={opt.id}
              label={opt.label}
              description={opt.description}
              kind={opt.kind}
              selected={opt.id === value}
              active={index === activeIndex}
              onPress={() => handleSelect(opt.id)}
            />
          ),
        )
      ) : (
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
      )}
    </>
  );

  const defaultContent = optionsList;

  const content = children ?? defaultContent;

  if (isMobile) {
    return (
      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        enableDismissOnClose={enableDismissOnClose}
        stackBehavior={stackBehavior}
        backgroundComponent={ComboboxSheetBackground}
        handleIndicatorStyle={{ backgroundColor: theme.colors.palette.zinc[600] }}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
      >
        <View style={styles.bottomSheetHeader}>
          <Text style={[styles.comboboxTitle, { color: theme.colors.foreground }]}>{title}</Text>
        </View>
        {stickyHeader}
        {!children && searchable ? searchInput : null}
        <BottomSheetScrollView
          contentContainerStyle={styles.comboboxScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  }

  if (!isOpen) return <></>;

  return (
    <Modal transparent animationType="none" visible={isOpen} onRequestClose={handleClose}>
      <View ref={refs.setOffsetParent} collapsable={false} style={styles.desktopOverlay}>
        <Pressable style={styles.desktopBackdrop} onPress={handleClose} />
        <Animated.View
          testID="combobox-desktop-container"
          entering={shouldUseDesktopFade ? FadeIn.duration(100) : undefined}
          exiting={shouldUseDesktopFade ? FadeOut.duration(100) : undefined}
          style={[
            styles.desktopContainer,
            {
              position: "absolute",
              minWidth: desktopMinWidth ?? referenceWidth ?? 200,
              maxWidth: Math.max(400, desktopMinWidth ?? 0),
            },
            desktopFixedHeight != null
              ? { minHeight: desktopFixedHeight, maxHeight: desktopFixedHeight }
              : null,
            desktopPositionStyle,
            shouldHideDesktopContent ? { opacity: 0 } : null,
            typeof availableSize?.height === "number"
              ? { maxHeight: Math.min(availableSize.height, desktopFixedHeight ?? 400) }
              : null,
          ]}
          ref={refs.setFloating}
          collapsable={false}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setDesktopContentWidth((prev) => (prev === width ? prev : width));
            if (!useMeasuredTopStartPosition || !hasResolvedDesktopPosition) {
              void update();
            }
          }}
        >
          {children ? (
            <>
              {stickyHeader}
              <ScrollView
                contentContainerStyle={styles.desktopChildrenScrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                style={styles.desktopScroll}
              >
                {content}
              </ScrollView>
            </>
          ) : (
            <>
              {stickyHeader}
              {searchable ? searchInput : null}
              {effectiveOptionsPosition === "above-search" ? (
                <ScrollView
                  ref={desktopOptionsScrollRef}
                  contentContainerStyle={[
                    styles.desktopScrollContent,
                    styles.desktopScrollContentAboveSearch,
                  ]}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  style={styles.desktopScroll}
                  onContentSizeChange={handleDesktopOptionsContentSizeChange}
                >
                  {optionsList}
                </ScrollView>
              ) : (
                <ScrollView
                  contentContainerStyle={styles.desktopScrollContent}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                  style={styles.desktopScroll}
                >
                  {optionsList}
                </ScrollView>
              )}
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  searchInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    ...(IS_WEB ? {} : { marginHorizontal: theme.spacing[1] }),
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  comboboxItem: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: 0,
    ...(IS_WEB
      ? {}
      : {
          marginHorizontal: theme.spacing[1],
          marginBottom: theme.spacing[1],
        }),
  },
  comboboxItemHovered: {
    backgroundColor: theme.colors.surface1,
  },
  comboboxItemHoveredElevated: {
    backgroundColor: theme.colors.surface2,
  },
  comboboxItemPressed: {
    backgroundColor: theme.colors.surface1,
  },
  comboboxItemPressedElevated: {
    backgroundColor: theme.colors.surface2,
  },
  comboboxItemActive: {
    backgroundColor: theme.colors.surface1,
  },
  comboboxItemDisabled: {
    opacity: 0.55,
  },
  comboboxItemTrailingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  comboboxItemTrailingContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
  },
  comboboxItemContent: {
    flex: 1,
    flexShrink: 1,
  },
  comboboxItemContentInline: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  comboboxItemLeadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  comboboxItemLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  comboboxItemDescription: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bottomSheetHeader: {
    paddingHorizontal: theme.spacing[6],
    paddingBottom: theme.spacing[2],
  },
  comboboxTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    textAlign: "left",
  },
  comboboxScrollContent: {
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  desktopOverlay: {
    flex: 1,
  },
  desktopBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  desktopContainer: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.md,
    maxHeight: 400,
    overflow: "hidden",
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  desktopScrollContent: {
    paddingVertical: theme.spacing[1],
  },
  desktopChildrenScrollContent: {
    // No padding — custom children (e.g. model selector) control their own spacing
  },
  desktopScrollContentAboveSearch: {
    flexGrow: 1,
    justifyContent: "flex-end",
  },
}));
