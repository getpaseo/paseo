import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetTextInput,
  BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Check, Folder, Search } from "lucide-react-native";
import { flip, offset as floatingOffset, shift, size as floatingSize, useFloating } from "@floating-ui/react-native";
import { getNextActiveIndex } from "./combobox-keyboard";

const IS_WEB = Platform.OS === "web";

export interface ComboboxOption {
  id: string;
  label: string;
  description?: string;
  kind?: "directory";
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onSelect: (id: string) => void;
  onSearchQueryChange?: (query: string) => void;
  searchable?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustomValue?: boolean;
  customValuePrefix?: string;
  customValueDescription?: string;
  customValueKind?: "directory";
  optionsPosition?: "below-search" | "above-search";
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  desktopPlacement?: "top-start" | "bottom-start";
  /**
   * Prevents an initial frame at 0,0 by hiding desktop content until floating
   * coordinates resolve. This intentionally disables fade enter/exit animation
   * for that combobox instance to avoid animation overriding hidden opacity.
   */
  desktopPreventInitialFlash?: boolean;
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
  return (
    <Animated.View
      pointerEvents="none"
      style={[style, styles.bottomSheetBackground]}
    />
  );
}

interface SearchInputProps {
  placeholder: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing?: () => void;
  autoFocus?: boolean;
}

function SearchInput({
  placeholder,
  value,
  onChangeText,
  onSubmitEditing,
  autoFocus = false,
}: SearchInputProps): ReactElement {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInput>(null);
  const InputComponent = Platform.OS === "web" ? TextInput : BottomSheetTextInput;

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
  kind?: "directory";
  selected?: boolean;
  active?: boolean;
  onPress: () => void;
  testID?: string;
}

export function ComboboxItem({
  label,
  description,
  kind,
  selected,
  active,
  onPress,
  testID,
}: ComboboxItemProps): ReactElement {
  const { theme } = useUnistyles();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed, hovered = false }) => [
        styles.comboboxItem,
        hovered && styles.comboboxItemHovered,
        pressed && styles.comboboxItemPressed,
        active && styles.comboboxItemActive,
      ]}
    >
      {kind === "directory" ? (
        <View style={styles.comboboxItemLeadingSlot}>
          <Folder size={16} color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
      <View style={styles.comboboxItemContent}>
        <Text numberOfLines={1} style={styles.comboboxItemLabel}>{label}</Text>
        {description ? (
          <Text numberOfLines={2} style={styles.comboboxItemDescription}>{description}</Text>
        ) : null}
      </View>
      {selected ? (
        <View style={styles.comboboxItemTrailingSlot}>
          <Check size={16} color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
    </Pressable>
  );
}

export function ComboboxEmpty({ children }: { children: ReactNode }): ReactElement {
  return <Text style={styles.emptyText}>{children}</Text>;
}

export function Combobox({
  options,
  value,
  onSelect,
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
  desktopPlacement = "top-start",
  desktopPreventInitialFlash = true,
  anchorRef,
  children,
}: ComboboxProps): ReactElement {
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const effectiveOptionsPosition =
    isMobile ? "below-search" : optionsPosition;
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ["60%", "90%"], []);
  const [availableSize, setAvailableSize] = useState<{ width?: number; height?: number } | null>(null);
  const [referenceWidth, setReferenceWidth] = useState<number | null>(null);
  const [referenceAtOrigin, setReferenceAtOrigin] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState<number>(-1);

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
    [isControlled, onOpenChange]
  );

  const setSearchQueryWithCallback = useCallback(
    (nextQuery: string) => {
      setSearchQuery(nextQuery);
      onSearchQueryChange?.(nextQuery);
    },
    [onSearchQueryChange]
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
      floatingOffset(Platform.OS === "web" ? 0 : 4),
      ...(Platform.OS === "web" ? [] : [flip({ padding: collisionPadding })]),
      shift({ padding: collisionPadding }),
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
            if (prev === next) return prev;
            return next;
          });
        },
      }),
    ],
    [collisionPadding]
  );

  const { refs, floatingStyles, update } = useFloating({
    placement: Platform.OS === "web" ? desktopPlacement : "bottom-start",
    middleware,
    sameScrollView: false,
    elements: {
      reference: anchorRef.current ?? undefined,
    },
  });

  useEffect(() => {
    if (!isOpen || isMobile) {
      setAvailableSize(null);
      setReferenceWidth(null);
      return;
    }
    const raf = requestAnimationFrame(() => void update());
    return () => cancelAnimationFrame(raf);
  }, [desktopPlacement, isMobile, update, isOpen]);

  useEffect(() => {
    if (!isOpen || isMobile) {
      setReferenceAtOrigin(false);
      return;
    }

    const referenceEl = anchorRef.current;
    if (!referenceEl) {
      setReferenceAtOrigin(false);
      return;
    }

    referenceEl.measureInWindow((x, y) => {
      setReferenceAtOrigin(Math.abs(x) <= 1 && Math.abs(y) <= 1);
    });
  }, [anchorRef, isMobile, isOpen]);

  const floatingTop = toNumericStyleValue(floatingStyles.top);
  const floatingLeft = toNumericStyleValue(floatingStyles.left);
  const hasResolvedDesktopPosition =
    referenceWidth !== null &&
    floatingTop !== null &&
    floatingLeft !== null &&
    (floatingTop !== 0 || floatingLeft !== 0 || referenceAtOrigin);
  const shouldHideDesktopContent =
    desktopPreventInitialFlash && !hasResolvedDesktopPosition;
  const shouldUseDesktopFade = !desktopPreventInitialFlash;

  useEffect(() => {
    if (!isMobile) return;
    if (isOpen) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [isOpen, isMobile]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        handleClose();
      }
    },
    [handleClose]
  );

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.45}
      />
    ),
    []
  );

  const normalizedSearch = searchable ? searchQuery.trim().toLowerCase() : "";
  const filteredOptions = useMemo(() => {
    if (!normalizedSearch) {
      return options;
    }
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(normalizedSearch) ||
        opt.id.toLowerCase().includes(normalizedSearch) ||
        opt.description?.toLowerCase().includes(normalizedSearch)
    );
  }, [options, normalizedSearch]);

  const sanitizedSearchValue = searchQuery.trim();
  const showCustomOption =
    searchable &&
    allowCustomValue &&
    sanitizedSearchValue.length > 0 &&
    !options.some(
      (opt) =>
        opt.id.toLowerCase() === sanitizedSearchValue.toLowerCase() ||
        opt.label.toLowerCase() === sanitizedSearchValue.toLowerCase()
    );

  const visibleOptions = useMemo(() => {
    const next: Array<{
      id: string;
      label: string;
      description?: string;
      kind?: "directory";
    }> = [];

    if (showCustomOption) {
      const trimmedPrefix = customValuePrefix.trim();
      const customLabel =
        trimmedPrefix.length > 0
          ? `${trimmedPrefix} "${sanitizedSearchValue}"`
          : sanitizedSearchValue;
      next.push({
        id: sanitizedSearchValue,
        label: customLabel,
        description: customValueDescription,
        kind: customValueKind,
      });
    }

    for (const opt of filteredOptions) {
      next.push({
        id: opt.id,
        label: opt.label,
        description: opt.description,
        kind: opt.kind,
      });
    }

    return next;
  }, [
    customValueDescription,
    customValueKind,
    customValuePrefix,
    filteredOptions,
    sanitizedSearchValue,
    showCustomOption,
  ]);

  const orderedVisibleOptions = useMemo(() => {
    if (effectiveOptionsPosition !== "above-search") {
      return visibleOptions;
    }
    return [...visibleOptions].reverse();
  }, [effectiveOptionsPosition, visibleOptions]);

  useEffect(() => {
    if (!isOpen) return;
    if (!IS_WEB && isMobile) return;

    if (orderedVisibleOptions.length === 0) {
      setActiveIndex(-1);
      return;
    }

    const fallbackIndex =
      effectiveOptionsPosition === "above-search" ? orderedVisibleOptions.length - 1 : 0;

    if (normalizedSearch) {
      setActiveIndex(fallbackIndex);
      return;
    }

    const selectedIndex = orderedVisibleOptions.findIndex((opt) => opt.id === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
  }, [
    effectiveOptionsPosition,
    isMobile,
    isOpen,
    normalizedSearch,
    value,
    orderedVisibleOptions,
  ]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      handleClose();
    },
    [handleClose, onSelect]
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
          })
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
    [activeIndex, handleClose, handleSelect, isMobile, isOpen, orderedVisibleOptions]
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
    />
  );

  const optionsList = (
    <>
      {orderedVisibleOptions.length > 0 ? (
        orderedVisibleOptions.map((opt, index) => (
          <ComboboxItem
            key={opt.id}
            label={opt.label}
            description={opt.description}
            kind={opt.kind}
            selected={opt.id === value}
            active={index === activeIndex}
            onPress={() => handleSelect(opt.id)}
          />
        ))
      ) : (
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
      )}
    </>
  );

  const defaultContent = (
    <>
      {effectiveOptionsPosition === "above-search" ? optionsList : null}
      {searchable ? searchInput : null}
      {effectiveOptionsPosition === "below-search" ? optionsList : null}
    </>
  );

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
        backgroundComponent={ComboboxSheetBackground}
        handleIndicatorStyle={styles.bottomSheetHandle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
      >
        <View style={styles.bottomSheetHeader}>
          <Text style={styles.comboboxTitle}>{title}</Text>
        </View>
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
    <Modal
      transparent
      animationType="none"
      visible={isOpen}
      onRequestClose={handleClose}
    >
      <View ref={refs.setOffsetParent} collapsable={false} style={styles.desktopOverlay}>
        <Pressable style={styles.desktopBackdrop} onPress={handleClose} />
        <Animated.View
          entering={shouldUseDesktopFade ? FadeIn.duration(100) : undefined}
          exiting={shouldUseDesktopFade ? FadeOut.duration(100) : undefined}
          style={[
            styles.desktopContainer,
            {
              position: "absolute",
              minWidth: referenceWidth ?? 200,
              maxWidth: 400,
            },
            floatingStyles,
            shouldHideDesktopContent ? { opacity: 0 } : null,
            typeof availableSize?.height === "number" ? { maxHeight: Math.min(availableSize.height, 400) } : null,
          ]}
          ref={refs.setFloating}
          collapsable={false}
          onLayout={() => update()}
        >
          {children ? (
            <ScrollView
              contentContainerStyle={styles.desktopScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              style={styles.desktopScroll}
            >
              {content}
            </ScrollView>
          ) : (
            <>
              {searchable ? searchInput : null}
              <ScrollView
                contentContainerStyle={styles.desktopScrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                style={styles.desktopScroll}
              >
                {optionsList}
              </ScrollView>
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
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    marginTop: theme.spacing[1],
    gap: theme.spacing[2],
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
  comboboxItemPressed: {
    backgroundColor: theme.colors.surface1,
  },
  comboboxItemActive: {
    backgroundColor: theme.colors.surface1,
  },
  comboboxItemTrailingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: "auto",
  },
  comboboxItemContent: {
    flex: 1,
    flexShrink: 1,
  },
  comboboxItemLeadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  comboboxItemLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  comboboxItemDescription: {
    marginTop: 2,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bottomSheetBackground: {
    backgroundColor: theme.colors.surface0,
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
  },
  bottomSheetHandle: {
    backgroundColor: theme.colors.palette.zinc[600],
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
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
    maxHeight: 400,
    overflow: "hidden",
  },
  desktopScroll: {
    maxHeight: 400,
  },
  desktopScrollContent: {
    paddingVertical: theme.spacing[1],
  },
}));
