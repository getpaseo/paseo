import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode, Ref } from "react";
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
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
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
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "./isolated-bottom-sheet-modal";

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

function resolveControlledOpen(
  open: boolean | undefined,
  internalOpen: boolean,
): { isControlled: boolean; isOpen: boolean } {
  const isControlled = typeof open === "boolean";
  return { isControlled, isOpen: isControlled ? open : internalOpen };
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
        ref={inputRef as unknown as Ref<never>}
        // @ts-expect-error - outlineStyle is web-only
        style={SEARCH_INPUT_STYLE}
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

  let leadingContent: ReactElement | null = null;
  if (leadingSlot) {
    leadingContent = <View style={styles.comboboxItemLeadingSlot}>{leadingSlot}</View>;
  } else if (kind === "directory") {
    leadingContent = (
      <View style={styles.comboboxItemLeadingSlot}>
        <Folder size={16} color={theme.colors.foregroundMuted} />
      </View>
    );
  } else if (kind === "file") {
    leadingContent = (
      <View style={styles.comboboxItemLeadingSlot}>
        <File size={16} color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  const itemPressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.comboboxItem,
      hovered && (elevated ? styles.comboboxItemHoveredElevated : styles.comboboxItemHovered),
      pressed && (elevated ? styles.comboboxItemPressedElevated : styles.comboboxItemPressed),
      active && styles.comboboxItemActive,
      disabled && styles.comboboxItemDisabled,
    ],
    [elevated, active, disabled],
  );

  const itemContentStyle = useMemo(
    () => [styles.comboboxItemContent, description && styles.comboboxItemContentInline],
    [description],
  );

  return (
    <Pressable testID={testID} disabled={disabled} onPress={onPress} style={itemPressableStyle}>
      {leadingContent}
      <View style={itemContentStyle}>
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

type RenderOptionFn = NonNullable<ComboboxProps["renderOption"]>;

interface OptionRowProps {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onSelect: (id: string) => void;
  renderOption: RenderOptionFn | undefined;
}

function OptionRow({ option, selected, active, onSelect, renderOption }: OptionRowProps) {
  const handlePress = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  if (renderOption) {
    return <View>{renderOption({ option, selected, active, onPress: handlePress })}</View>;
  }
  return (
    <ComboboxItem
      label={option.label}
      description={option.description}
      kind={option.kind}
      selected={selected}
      active={active}
      onPress={handlePress}
    />
  );
}

interface OptionsListProps {
  options: ComboboxOption[];
  value: string;
  activeIndex: number;
  emptyText: string;
  onSelect: (id: string) => void;
  renderOption: RenderOptionFn | undefined;
}

function OptionsList({
  options,
  value,
  activeIndex,
  emptyText,
  onSelect,
  renderOption,
}: OptionsListProps): ReactElement {
  if (options.length === 0) {
    return <ComboboxEmpty>{emptyText}</ComboboxEmpty>;
  }
  return (
    <>
      {options.map((opt, index) => (
        <OptionRow
          key={opt.id}
          option={opt}
          selected={opt.id === value}
          active={index === activeIndex}
          onSelect={onSelect}
          renderOption={renderOption}
        />
      ))}
    </>
  );
}

interface DesktopPositionInput {
  isDesktopAboveSearch: boolean;
  isMobile: boolean;
  desktopPlacement: "top-start" | "bottom-start";
  referenceTop: number | null;
  referenceLeft: number | null;
  referenceAtOrigin: boolean;
  desktopContentWidth: number | null;
  windowWidth: number;
  windowHeight: number;
  collisionPadding: number;
  floatingTop: number | null;
  floatingLeft: number | null;
  floatingStyles: ReturnType<typeof useFloating>["floatingStyles"];
  desktopPreventInitialFlash: boolean;
  referenceWidth: number | null;
}

interface DesktopPositionResult {
  desktopPositionStyle:
    | { left: number; bottom: number }
    | ReturnType<typeof useFloating>["floatingStyles"];
  hasResolvedDesktopPosition: boolean;
  shouldHideDesktopContent: boolean;
  shouldUseDesktopFade: boolean;
  useMeasuredTopStartPosition: boolean;
}

function shouldUseMeasuredTopStart(input: DesktopPositionInput): boolean {
  return (
    !input.isDesktopAboveSearch &&
    IS_WEB &&
    !input.isMobile &&
    input.desktopPlacement === "top-start" &&
    input.referenceTop !== null &&
    input.referenceLeft !== null &&
    input.desktopContentWidth !== null
  );
}

function resolvePositionReady(
  input: DesktopPositionInput,
  useMeasured: boolean,
  measuredLeft: number | null,
  measuredBottom: number | null,
  aboveSearchBottom: number | null,
): boolean {
  const { isDesktopAboveSearch, floatingLeft, floatingTop, referenceAtOrigin } = input;
  const hasNonZeroFloating = (floatingTop ?? 0) !== 0 || floatingLeft !== 0;
  if (isDesktopAboveSearch) {
    return floatingLeft !== null && aboveSearchBottom !== null;
  }
  if (useMeasured) {
    return measuredLeft !== null && measuredBottom !== null;
  }
  return floatingLeft !== null && floatingTop !== null && (hasNonZeroFloating || referenceAtOrigin);
}

function computeDesktopPosition(input: DesktopPositionInput): DesktopPositionResult {
  const {
    isDesktopAboveSearch,
    referenceTop,
    referenceLeft,
    desktopContentWidth,
    windowWidth,
    windowHeight,
    collisionPadding,
    floatingLeft,
    floatingStyles,
    desktopPreventInitialFlash,
    referenceWidth,
  } = input;

  const desktopAboveSearchBottom =
    isDesktopAboveSearch && referenceTop !== null
      ? Math.max(windowHeight - referenceTop, collisionPadding)
      : null;
  const useMeasuredTopStartPosition = shouldUseMeasuredTopStart(input);
  const clampedMeasuredTopStartLeft =
    useMeasuredTopStartPosition && referenceLeft !== null && desktopContentWidth !== null
      ? Math.max(
          collisionPadding,
          Math.min(windowWidth - desktopContentWidth - collisionPadding, referenceLeft),
        )
      : null;
  const measuredTopStartBottom =
    useMeasuredTopStartPosition && referenceTop !== null
      ? Math.max(windowHeight - referenceTop + 5, collisionPadding)
      : null;

  const resolvedPositionReady = resolvePositionReady(
    input,
    useMeasuredTopStartPosition,
    clampedMeasuredTopStartLeft,
    measuredTopStartBottom,
    desktopAboveSearchBottom,
  );
  const hasResolvedDesktopPosition =
    referenceWidth !== null && referenceWidth > 0 && resolvedPositionReady;
  const shouldHideDesktopContent = desktopPreventInitialFlash && !hasResolvedDesktopPosition;
  const shouldUseDesktopFade = !desktopPreventInitialFlash;

  let desktopPositionStyle: DesktopPositionResult["desktopPositionStyle"];
  if (isDesktopAboveSearch) {
    desktopPositionStyle = {
      left: floatingLeft ?? 0,
      bottom: desktopAboveSearchBottom ?? 0,
    };
  } else if (useMeasuredTopStartPosition) {
    desktopPositionStyle = {
      left: clampedMeasuredTopStartLeft ?? 0,
      bottom: measuredTopStartBottom ?? 0,
    };
  } else {
    desktopPositionStyle = floatingStyles;
  }

  return {
    desktopPositionStyle,
    hasResolvedDesktopPosition,
    shouldHideDesktopContent,
    shouldUseDesktopFade,
    useMeasuredTopStartPosition,
  };
}

function advanceActiveIndex(itemCount: number, key: "ArrowDown" | "ArrowUp") {
  return (currentIndex: number) => getNextActiveIndex({ currentIndex, itemCount, key });
}

type DesktopKey = "ArrowDown" | "ArrowUp" | "Enter" | "Escape";

interface DesktopKeyHandlerInput {
  isOpen: boolean;
  isMobile: boolean;
  orderedVisibleOptions: ComboboxOption[];
  activeIndex: number;
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  handleSelect: (id: string) => void;
  handleClose: () => void;
}

function handleDesktopArrowKey(input: DesktopKeyHandlerInput, key: "ArrowDown" | "ArrowUp") {
  input.setActiveIndex(advanceActiveIndex(input.orderedVisibleOptions.length, key));
}

function handleDesktopEnterKey(input: DesktopKeyHandlerInput) {
  if (input.orderedVisibleOptions.length === 0) return;
  const { activeIndex, orderedVisibleOptions } = input;
  const index = activeIndex >= 0 && activeIndex < orderedVisibleOptions.length ? activeIndex : 0;
  input.handleSelect(orderedVisibleOptions[index].id);
}

interface FloatingSizeSetters {
  setAvailableSize: React.Dispatch<
    React.SetStateAction<{ width?: number; height?: number } | null>
  >;
  setReferenceWidth: React.Dispatch<React.SetStateAction<number | null>>;
}

function updateAvailableSize(
  setAvailableSize: FloatingSizeSetters["setAvailableSize"],
  availableWidth: number,
  availableHeight: number,
) {
  setAvailableSize((prev) => {
    const next = { width: availableWidth, height: availableHeight };
    if (!prev) return next;
    if (prev.width === next.width && prev.height === next.height) return prev;
    return next;
  });
}

function updateReferenceWidth(
  setReferenceWidth: FloatingSizeSetters["setReferenceWidth"],
  width: number,
) {
  setReferenceWidth((prev) => {
    if (!(width > 0)) return prev;
    if (prev === width) return prev;
    return width;
  });
}

interface MeasuredAnchorSetters {
  setReferenceLeft: React.Dispatch<React.SetStateAction<number | null>>;
  setReferenceTop: React.Dispatch<React.SetStateAction<number | null>>;
  setReferenceWidth: React.Dispatch<React.SetStateAction<number | null>>;
  setReferenceAtOrigin: React.Dispatch<React.SetStateAction<boolean>>;
}

function applyMeasuredAnchor(setters: MeasuredAnchorSetters, x: number, y: number, width: number) {
  setters.setReferenceLeft((prev) => (prev === x ? prev : x));
  setters.setReferenceAtOrigin(Math.abs(x) <= 1 && Math.abs(y) <= 1);
  setters.setReferenceTop((prev) => (prev === y ? prev : y));
  updateReferenceWidth(setters.setReferenceWidth, width);
}

function useActiveIndexSync(
  isOpen: boolean,
  isMobile: boolean,
  orderedVisibleOptions: ComboboxOption[],
  effectiveOptionsPosition: "below-search" | "above-search",
  normalizedSearch: string,
  value: string,
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    if (!isOpen) return;
    if (!IS_WEB && isMobile) return;
    setActiveIndex(
      resolveInitialActiveIndex(
        orderedVisibleOptions,
        effectiveOptionsPosition,
        normalizedSearch,
        value,
      ),
    );
  }, [
    effectiveOptionsPosition,
    isMobile,
    isOpen,
    normalizedSearch,
    value,
    orderedVisibleOptions,
    setActiveIndex,
  ]);
}

function useDesktopOptionsPinToBottom(
  isOpen: boolean,
  orderedVisibleOptions: ComboboxOption[],
  pinDesktopOptionsToBottom: () => void,
) {
  useEffect(() => {
    if (!isOpen) return;
    pinDesktopOptionsToBottom();
  }, [isOpen, orderedVisibleOptions, pinDesktopOptionsToBottom]);
}

function useDesktopFloatingUpdate(
  isOpen: boolean,
  isMobile: boolean,
  orderedVisibleOptionsLength: number,
  searchQuery: string,
  update: () => unknown,
) {
  useLayoutEffect(() => {
    if (!isOpen || isMobile) return;
    void update();
  }, [isOpen, isMobile, orderedVisibleOptionsLength, searchQuery, update]);
}

function useResetSearchOnOpen(
  isOpen: boolean,
  setSearchQueryWithCallback: (query: string) => void,
) {
  useEffect(() => {
    if (isOpen) {
      setSearchQueryWithCallback("");
    }
  }, [isOpen, setSearchQueryWithCallback]);
}

interface DesktopResetSetters {
  setAvailableSize: React.Dispatch<
    React.SetStateAction<{ width?: number; height?: number } | null>
  >;
  setDesktopContentWidth: React.Dispatch<React.SetStateAction<number | null>>;
  setReferenceLeft: React.Dispatch<React.SetStateAction<number | null>>;
  setReferenceWidth: React.Dispatch<React.SetStateAction<number | null>>;
}

function useDesktopPositionReset(
  isOpen: boolean,
  isMobile: boolean,
  desktopPlacement: "top-start" | "bottom-start",
  update: () => unknown,
  setters: DesktopResetSetters,
) {
  const { setAvailableSize, setDesktopContentWidth, setReferenceLeft, setReferenceWidth } = setters;
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
  }, [
    desktopPlacement,
    isMobile,
    isOpen,
    update,
    setAvailableSize,
    setDesktopContentWidth,
    setReferenceLeft,
    setReferenceWidth,
  ]);
}

function useAnchorMeasure(
  isOpen: boolean,
  isMobile: boolean,
  anchorRef: React.RefObject<View | null>,
  searchQuery: string,
  windowHeight: number,
  setters: MeasuredAnchorSetters,
) {
  const { setReferenceLeft, setReferenceTop, setReferenceWidth, setReferenceAtOrigin } = setters;
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
      referenceEl.measureInWindow((x, y, width) => {
        applyMeasuredAnchor(
          { setReferenceLeft, setReferenceTop, setReferenceWidth, setReferenceAtOrigin },
          x,
          y,
          width,
        );
      });
    };

    measure();
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [
    anchorRef,
    isMobile,
    isOpen,
    searchQuery,
    windowHeight,
    setReferenceLeft,
    setReferenceTop,
    setReferenceWidth,
    setReferenceAtOrigin,
  ]);
}

function applySetOpen(
  isControlled: boolean,
  setInternalOpen: React.Dispatch<React.SetStateAction<boolean>>,
  onOpenChange: ((open: boolean) => void) | undefined,
  nextOpen: boolean,
) {
  if (!isControlled) {
    setInternalOpen(nextOpen);
  }
  onOpenChange?.(nextOpen);
}

function applySetSearchQuery(
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>,
  onSearchQueryChange: ((query: string) => void) | undefined,
  nextQuery: string,
) {
  setSearchQuery(nextQuery);
  onSearchQueryChange?.(nextQuery);
}

function applyDesktopContentLayout(
  event: LayoutChangeEvent,
  setDesktopContentWidth: React.Dispatch<React.SetStateAction<number | null>>,
  useMeasuredTopStartPosition: boolean,
  hasResolvedDesktopPosition: boolean,
  update: () => unknown,
) {
  const { width } = event.nativeEvent.layout;
  setDesktopContentWidth((prev) => (prev === width ? prev : width));
  if (!useMeasuredTopStartPosition || !hasResolvedDesktopPosition) {
    void update();
  }
}

function runIfSelected(keepOpenOnSelect: boolean, handleClose: () => void) {
  if (!keepOpenOnSelect) {
    handleClose();
  }
}

function runIfPinOpen(isOpen: boolean, pin: () => void) {
  if (!isOpen) return;
  pin();
}

function runIfSubmitSearch(
  showCustomOption: boolean,
  handleSelect: (id: string) => void,
  sanitizedSearchValue: string,
) {
  if (showCustomOption) {
    handleSelect(sanitizedSearchValue);
  }
}

function computeCollisionPadding(): number {
  const basePadding = 16;
  if (Platform.OS !== "android") return basePadding;
  const statusBarHeight = StatusBar.currentHeight ?? 0;
  return Math.max(basePadding, statusBarHeight + basePadding);
}

function scrollDesktopOptionsToEnd(scrollRef: React.RefObject<ScrollView | null>) {
  scrollRef.current?.scrollToEnd({ animated: false });
  requestAnimationFrame(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  });
}

function resolveEffectiveOptionsPosition(
  isMobile: boolean,
  optionsPosition: "below-search" | "above-search",
): "below-search" | "above-search" {
  return isMobile ? "below-search" : optionsPosition;
}

function resolveIsDesktopAboveSearch(
  isMobile: boolean,
  effectiveOptionsPosition: "below-search" | "above-search",
): boolean {
  return !isMobile && isWeb && effectiveOptionsPosition === "above-search";
}

function maybePinDesktopOptionsToBottom(
  isMobile: boolean,
  effectiveOptionsPosition: "below-search" | "above-search",
  scrollRef: React.RefObject<ScrollView | null>,
) {
  if (isMobile || effectiveOptionsPosition !== "above-search") return;
  scrollDesktopOptionsToEnd(scrollRef);
}

interface FloatingMiddlewareInput {
  collisionPadding: number;
  isDesktopAboveSearch: boolean;
  setAvailableSize: FloatingSizeSetters["setAvailableSize"];
  setReferenceWidth: FloatingSizeSetters["setReferenceWidth"];
}

function buildFloatingMiddleware(input: FloatingMiddlewareInput) {
  const { collisionPadding, isDesktopAboveSearch, setAvailableSize, setReferenceWidth } = input;
  return [
    floatingOffset(isWeb ? 5 : 4),
    ...(isWeb ? [] : [flip({ padding: collisionPadding })]),
    ...(isDesktopAboveSearch ? [] : [shift({ padding: collisionPadding })]),
    floatingSize({
      padding: collisionPadding,
      apply({ availableWidth, availableHeight, rects }) {
        updateAvailableSize(setAvailableSize, availableWidth, availableHeight);
        updateReferenceWidth(setReferenceWidth, rects.reference.width);
      },
    }),
  ];
}

interface DesktopContainerStyleInput {
  desktopMinWidth: number | undefined;
  referenceWidth: number | null;
  desktopFixedHeight: number | undefined;
  desktopPositionStyle: DesktopPositionResult["desktopPositionStyle"];
  shouldHideDesktopContent: boolean;
  availableHeight: number | undefined;
}

function buildDesktopContainerStyle(input: DesktopContainerStyleInput) {
  const {
    desktopMinWidth,
    referenceWidth,
    desktopFixedHeight,
    desktopPositionStyle,
    shouldHideDesktopContent,
    availableHeight,
  } = input;
  const fixedHeightStyle =
    desktopFixedHeight != null
      ? { minHeight: desktopFixedHeight, maxHeight: desktopFixedHeight }
      : null;
  const hiddenStyle = shouldHideDesktopContent ? { opacity: 0 } : null;
  const availableHeightStyle =
    typeof availableHeight === "number"
      ? { maxHeight: Math.min(availableHeight, desktopFixedHeight ?? 400) }
      : null;
  return [
    styles.desktopContainer,
    {
      position: "absolute" as const,
      minWidth: desktopMinWidth ?? referenceWidth ?? 200,
      maxWidth: Math.max(400, desktopMinWidth ?? 0),
    },
    fixedHeightStyle,
    desktopPositionStyle,
    hiddenStyle,
    availableHeightStyle,
  ];
}

function isDesktopKey(key: string): key is DesktopKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Escape";
}

function useWebKeyboardListener(
  isOpen: boolean,
  handleDesktopKey: (key: DesktopKey, event?: KeyboardEvent) => void,
) {
  useEffect(() => {
    if (!IS_WEB || !isOpen) return;

    const handler = (event: KeyboardEvent) => {
      if (!isDesktopKey(event.key)) return;
      handleDesktopKey(event.key, event);
    };

    // react-native-web's TextInput can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
    };
  }, [handleDesktopKey, isOpen]);
}

function dispatchDesktopKey(input: DesktopKeyHandlerInput, key: DesktopKey, event?: KeyboardEvent) {
  if (!input.isOpen) return;
  if (!IS_WEB && input.isMobile) return;

  if (key === "ArrowDown" || key === "ArrowUp") {
    event?.preventDefault();
    handleDesktopArrowKey(input, key);
    return;
  }
  if (key === "Enter") {
    if (input.orderedVisibleOptions.length === 0) return;
    event?.preventDefault();
    handleDesktopEnterKey(input);
    return;
  }
  if (key === "Escape") {
    event?.preventDefault();
    input.handleClose();
  }
}

function resolveInitialActiveIndex(
  orderedVisibleOptions: ComboboxOption[],
  effectiveOptionsPosition: "below-search" | "above-search",
  normalizedSearch: string,
  value: string,
): number {
  if (orderedVisibleOptions.length === 0) return -1;
  const fallbackIndex = getComboboxFallbackIndex(
    orderedVisibleOptions.length,
    effectiveOptionsPosition,
  );
  if (normalizedSearch) return fallbackIndex;
  const selectedIndex = orderedVisibleOptions.findIndex((opt) => opt.id === value);
  return selectedIndex >= 0 ? selectedIndex : fallbackIndex;
}

type BottomSheetVisibility = ReturnType<typeof useIsolatedBottomSheetVisibility>;

interface MobileBodyProps {
  bottomSheetRef: BottomSheetVisibility["sheetRef"];
  snapPoints: string[];
  handleSheetChange: BottomSheetVisibility["handleSheetChange"];
  handleSheetDismiss: BottomSheetVisibility["handleSheetDismiss"];
  handleIndicatorStyle: { backgroundColor: string };
  titleColor: string;
  title: string;
  stickyHeader: ReactNode;
  searchable: boolean;
  hasChildren: boolean;
  searchPlaceholder: string;
  searchQuery: string;
  setSearchQueryWithCallback: (query: string) => void;
  handleSubmitSearch: () => void;
  orderedVisibleOptions: ComboboxOption[];
  value: string;
  activeIndex: number;
  emptyText: string;
  handleSelect: (id: string) => void;
  renderOption: RenderOptionFn | undefined;
  children: ReactNode;
}

function MobileComboboxBody(props: MobileBodyProps): ReactElement {
  const renderBackdrop = useCallback(
    (backdropProps: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...backdropProps}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.45}
      />
    ),
    [],
  );

  const comboboxTitleStyle = useMemo(
    () => [styles.comboboxTitle, { color: props.titleColor }],
    [props.titleColor],
  );

  const body = props.hasChildren ? (
    props.children
  ) : (
    <OptionsList
      options={props.orderedVisibleOptions}
      value={props.value}
      activeIndex={props.activeIndex}
      emptyText={props.emptyText}
      onSelect={props.handleSelect}
      renderOption={props.renderOption}
    />
  );

  return (
    <IsolatedBottomSheetModal
      ref={props.bottomSheetRef}
      snapPoints={props.snapPoints}
      index={0}
      enableDynamicSizing={false}
      onChange={props.handleSheetChange}
      onDismiss={props.handleSheetDismiss}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      backgroundComponent={ComboboxSheetBackground}
      handleIndicatorStyle={props.handleIndicatorStyle}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
    >
      <View style={styles.bottomSheetHeader}>
        <Text key={props.titleColor} style={comboboxTitleStyle}>
          {props.title}
        </Text>
      </View>
      {props.stickyHeader}
      {!props.hasChildren && props.searchable ? (
        <SearchInput
          placeholder={props.searchPlaceholder}
          value={props.searchQuery}
          onChangeText={props.setSearchQueryWithCallback}
          onSubmitEditing={props.handleSubmitSearch}
          autoFocus={false}
          useBottomSheetInput
        />
      ) : null}
      <BottomSheetScrollView
        contentContainerStyle={styles.comboboxScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </BottomSheetScrollView>
    </IsolatedBottomSheetModal>
  );
}

interface DesktopBodyProps {
  isOpen: boolean;
  handleClose: () => void;
  refs: ReturnType<typeof useFloating>["refs"];
  shouldUseDesktopFade: boolean;
  desktopContainerStyle: unknown;
  handleDesktopContentLayout: (event: LayoutChangeEvent) => void;
  stickyHeader: ReactNode;
  searchable: boolean;
  searchPlaceholder: string;
  searchQuery: string;
  setSearchQueryWithCallback: (query: string) => void;
  handleSubmitSearch: () => void;
  effectiveOptionsPosition: "below-search" | "above-search";
  desktopOptionsScrollRef: React.RefObject<ScrollView | null>;
  desktopAboveSearchContentContainerStyle: unknown;
  handleDesktopOptionsContentSizeChange: () => void;
  orderedVisibleOptions: ComboboxOption[];
  value: string;
  activeIndex: number;
  emptyText: string;
  handleSelect: (id: string) => void;
  renderOption: RenderOptionFn | undefined;
  hasChildren: boolean;
  children: ReactNode;
}

function DesktopComboboxChildrenBody(props: {
  stickyHeader: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      {props.stickyHeader}
      <ScrollView
        contentContainerStyle={styles.desktopChildrenScrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.desktopScroll}
      >
        {props.children}
      </ScrollView>
    </>
  );
}

function DesktopComboboxOptionsBody(props: {
  stickyHeader: ReactNode;
  searchable: boolean;
  searchPlaceholder: string;
  searchQuery: string;
  setSearchQueryWithCallback: (query: string) => void;
  handleSubmitSearch: () => void;
  effectiveOptionsPosition: "below-search" | "above-search";
  desktopOptionsScrollRef: React.RefObject<ScrollView | null>;
  desktopAboveSearchContentContainerStyle: unknown;
  handleDesktopOptionsContentSizeChange: () => void;
  orderedVisibleOptions: ComboboxOption[];
  value: string;
  activeIndex: number;
  emptyText: string;
  handleSelect: (id: string) => void;
  renderOption: RenderOptionFn | undefined;
}): ReactElement {
  const list = (
    <OptionsList
      options={props.orderedVisibleOptions}
      value={props.value}
      activeIndex={props.activeIndex}
      emptyText={props.emptyText}
      onSelect={props.handleSelect}
      renderOption={props.renderOption}
    />
  );

  return (
    <>
      {props.stickyHeader}
      {props.searchable ? (
        <SearchInput
          placeholder={props.searchPlaceholder}
          value={props.searchQuery}
          onChangeText={props.setSearchQueryWithCallback}
          onSubmitEditing={props.handleSubmitSearch}
          autoFocus
          useBottomSheetInput={false}
        />
      ) : null}
      {props.effectiveOptionsPosition === "above-search" ? (
        <ScrollView
          ref={props.desktopOptionsScrollRef}
          contentContainerStyle={props.desktopAboveSearchContentContainerStyle as never}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.desktopScroll}
          onContentSizeChange={props.handleDesktopOptionsContentSizeChange}
        >
          {list}
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.desktopScrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.desktopScroll}
        >
          {list}
        </ScrollView>
      )}
    </>
  );
}

function DesktopComboboxBody(props: DesktopBodyProps): ReactElement {
  return (
    <Modal
      transparent
      animationType="none"
      visible={props.isOpen}
      onRequestClose={props.handleClose}
    >
      <View ref={props.refs.setOffsetParent} collapsable={false} style={styles.desktopOverlay}>
        <Pressable style={styles.desktopBackdrop} onPress={props.handleClose} />
        <Animated.View
          testID="combobox-desktop-container"
          entering={props.shouldUseDesktopFade ? FadeIn.duration(100) : undefined}
          exiting={props.shouldUseDesktopFade ? FadeOut.duration(100) : undefined}
          style={props.desktopContainerStyle as never}
          ref={props.refs.setFloating}
          collapsable={false}
          onLayout={props.handleDesktopContentLayout}
        >
          {props.hasChildren ? (
            <DesktopComboboxChildrenBody stickyHeader={props.stickyHeader}>
              {props.children}
            </DesktopComboboxChildrenBody>
          ) : (
            <DesktopComboboxOptionsBody
              stickyHeader={props.stickyHeader}
              searchable={props.searchable}
              searchPlaceholder={props.searchPlaceholder}
              searchQuery={props.searchQuery}
              setSearchQueryWithCallback={props.setSearchQueryWithCallback}
              handleSubmitSearch={props.handleSubmitSearch}
              effectiveOptionsPosition={props.effectiveOptionsPosition}
              desktopOptionsScrollRef={props.desktopOptionsScrollRef}
              desktopAboveSearchContentContainerStyle={
                props.desktopAboveSearchContentContainerStyle
              }
              handleDesktopOptionsContentSizeChange={props.handleDesktopOptionsContentSizeChange}
              orderedVisibleOptions={props.orderedVisibleOptions}
              value={props.value}
              activeIndex={props.activeIndex}
              emptyText={props.emptyText}
              handleSelect={props.handleSelect}
              renderOption={props.renderOption}
            />
          )}
        </Animated.View>
      </View>
    </Modal>
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
  desktopPlacement = "top-start",
  desktopPreventInitialFlash = true,
  desktopMinWidth,
  desktopFixedHeight,
  stickyHeader,
  keepOpenOnSelect = false,
  anchorRef,
  children,
}: ComboboxProps): ReactElement | null {
  const { theme } = useUnistyles();
  const isMobile = useIsCompactFormFactor();
  const titleColor = theme.colors.foreground;
  const effectiveOptionsPosition = resolveEffectiveOptionsPosition(isMobile, optionsPosition);
  const isDesktopAboveSearch = resolveIsDesktopAboveSearch(isMobile, effectiveOptionsPosition);
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
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

  const [internalOpen, setInternalOpen] = useState(false);
  const { isControlled, isOpen } = resolveControlledOpen(open, internalOpen);

  const setOpen = useCallback(
    (nextOpen: boolean) => applySetOpen(isControlled, setInternalOpen, onOpenChange, nextOpen),
    [isControlled, onOpenChange],
  );

  const setSearchQueryWithCallback = useCallback(
    (nextQuery: string) => applySetSearchQuery(setSearchQuery, onSearchQueryChange, nextQuery),
    [onSearchQueryChange],
  );

  const handleClose = useCallback(() => {
    setOpen(false);
    setSearchQueryWithCallback("");
  }, [setOpen, setSearchQueryWithCallback]);

  useResetSearchOnOpen(isOpen, setSearchQueryWithCallback);

  const collisionPadding = useMemo(computeCollisionPadding, []);

  const middleware = useMemo(
    () =>
      buildFloatingMiddleware({
        collisionPadding,
        isDesktopAboveSearch,
        setAvailableSize,
        setReferenceWidth,
      }),
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

  useDesktopPositionReset(isOpen, isMobile, desktopPlacement, update, {
    setAvailableSize,
    setDesktopContentWidth,
    setReferenceLeft,
    setReferenceWidth,
  });

  useAnchorMeasure(isOpen, isMobile, anchorRef, searchQuery, windowHeight, {
    setReferenceLeft,
    setReferenceTop,
    setReferenceWidth,
    setReferenceAtOrigin,
  });

  const floatingTop = toNumericStyleValue(floatingStyles.top);
  const floatingLeft = toNumericStyleValue(floatingStyles.left);

  const {
    desktopPositionStyle,
    hasResolvedDesktopPosition,
    shouldHideDesktopContent,
    shouldUseDesktopFade,
    useMeasuredTopStartPosition,
  } = computeDesktopPosition({
    isDesktopAboveSearch,
    isMobile,
    desktopPlacement,
    referenceTop,
    referenceLeft,
    referenceAtOrigin,
    desktopContentWidth,
    windowWidth,
    windowHeight,
    collisionPadding,
    floatingTop,
    floatingLeft,
    floatingStyles,
    desktopPreventInitialFlash,
    referenceWidth,
  });

  const {
    sheetRef: bottomSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  } = useIsolatedBottomSheetVisibility({
    visible: isOpen,
    isEnabled: isMobile,
    onClose: handleClose,
  });

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

  const handleDesktopContentLayout = useCallback(
    (event: LayoutChangeEvent) =>
      applyDesktopContentLayout(
        event,
        setDesktopContentWidth,
        useMeasuredTopStartPosition,
        hasResolvedDesktopPosition,
        update,
      ),
    [useMeasuredTopStartPosition, hasResolvedDesktopPosition, update],
  );

  const pinDesktopOptionsToBottom = useCallback(
    () =>
      maybePinDesktopOptionsToBottom(isMobile, effectiveOptionsPosition, desktopOptionsScrollRef),
    [effectiveOptionsPosition, isMobile],
  );

  const handleDesktopOptionsContentSizeChange = useCallback(
    () => runIfPinOpen(isOpen, pinDesktopOptionsToBottom),
    [isOpen, pinDesktopOptionsToBottom],
  );

  useDesktopOptionsPinToBottom(isOpen, orderedVisibleOptions, pinDesktopOptionsToBottom);

  useDesktopFloatingUpdate(isOpen, isMobile, orderedVisibleOptions.length, searchQuery, update);

  useActiveIndexSync(
    isOpen,
    isMobile,
    orderedVisibleOptions,
    effectiveOptionsPosition,
    normalizedSearch,
    value,
    setActiveIndex,
  );

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      runIfSelected(keepOpenOnSelect, handleClose);
    },
    [handleClose, keepOpenOnSelect, onSelect],
  );

  const handleSubmitSearch = useCallback(
    () => runIfSubmitSearch(showCustomOption, handleSelect, sanitizedSearchValue),
    [handleSelect, sanitizedSearchValue, showCustomOption],
  );

  const handleDesktopKey = useCallback(
    (key: DesktopKey, event?: KeyboardEvent) => {
      dispatchDesktopKey(
        {
          isOpen,
          isMobile,
          orderedVisibleOptions,
          activeIndex,
          setActiveIndex,
          handleSelect,
          handleClose,
        },
        key,
        event,
      );
    },
    [activeIndex, handleClose, handleSelect, isMobile, isOpen, orderedVisibleOptions],
  );

  useWebKeyboardListener(isOpen, handleDesktopKey);

  const handleIndicatorStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
  );

  const desktopContainerStyle = useMemo(
    () =>
      buildDesktopContainerStyle({
        desktopMinWidth,
        referenceWidth,
        desktopFixedHeight,
        desktopPositionStyle,
        shouldHideDesktopContent,
        availableHeight: availableSize?.height,
      }),
    [
      desktopMinWidth,
      referenceWidth,
      desktopFixedHeight,
      desktopPositionStyle,
      shouldHideDesktopContent,
      availableSize?.height,
    ],
  );

  const desktopAboveSearchContentContainerStyle = useMemo(
    () => [styles.desktopScrollContent, styles.desktopScrollContentAboveSearch],
    [],
  );

  const effectiveSearchPlaceholder = searchPlaceholder ?? placeholder;
  const hasChildren = Boolean(children);

  if (isMobile) {
    return (
      <MobileComboboxBody
        bottomSheetRef={bottomSheetRef}
        snapPoints={snapPoints}
        handleSheetChange={handleSheetChange}
        handleSheetDismiss={handleSheetDismiss}
        handleIndicatorStyle={handleIndicatorStyle}
        titleColor={titleColor}
        title={title}
        stickyHeader={stickyHeader}
        searchable={searchable}
        hasChildren={hasChildren}
        searchPlaceholder={effectiveSearchPlaceholder}
        searchQuery={searchQuery}
        setSearchQueryWithCallback={setSearchQueryWithCallback}
        handleSubmitSearch={handleSubmitSearch}
        orderedVisibleOptions={orderedVisibleOptions}
        value={value}
        activeIndex={activeIndex}
        emptyText={emptyText}
        handleSelect={handleSelect}
        renderOption={renderOption}
      >
        {children}
      </MobileComboboxBody>
    );
  }

  if (!isOpen) return null;

  return (
    <DesktopComboboxBody
      isOpen={isOpen}
      handleClose={handleClose}
      refs={refs}
      shouldUseDesktopFade={shouldUseDesktopFade}
      desktopContainerStyle={desktopContainerStyle}
      handleDesktopContentLayout={handleDesktopContentLayout}
      stickyHeader={stickyHeader}
      searchable={searchable}
      searchPlaceholder={effectiveSearchPlaceholder}
      searchQuery={searchQuery}
      setSearchQueryWithCallback={setSearchQueryWithCallback}
      handleSubmitSearch={handleSubmitSearch}
      effectiveOptionsPosition={effectiveOptionsPosition}
      desktopOptionsScrollRef={desktopOptionsScrollRef}
      desktopAboveSearchContentContainerStyle={desktopAboveSearchContentContainerStyle}
      handleDesktopOptionsContentSizeChange={handleDesktopOptionsContentSizeChange}
      orderedVisibleOptions={orderedVisibleOptions}
      value={value}
      activeIndex={activeIndex}
      emptyText={emptyText}
      handleSelect={handleSelect}
      renderOption={renderOption}
      hasChildren={hasChildren}
    >
      {children}
    </DesktopComboboxBody>
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

const SEARCH_INPUT_STYLE = [styles.searchInput, IS_WEB && { outlineStyle: "none" }];
