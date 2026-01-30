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
import { Check, Search } from "lucide-react-native";
import {
  flip,
  offset as floatingOffset,
  shift,
  size as floatingSize,
  useFloating,
} from "@floating-ui/react-native";

const IS_WEB = Platform.OS === "web";

export interface ComboboxOption {
  id: string;
  label: string;
  description?: string;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value: string;
  onSelect: (id: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  allowCustomValue?: boolean;
  customValuePrefix?: string;
  customValueDescription?: string;
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchorRef: React.RefObject<View | null>;
  children?: ReactNode;
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
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}

export function ComboboxItem({
  label,
  description,
  selected,
  onPress,
  testID,
}: ComboboxItemProps): ReactElement {
  const { theme } = useUnistyles();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.comboboxItem,
        pressed && styles.comboboxItemPressed,
      ]}
    >
      <View style={styles.comboboxItemCheckSlot}>
        {selected ? <Check size={16} color={theme.colors.foreground} /> : null}
      </View>
      <View style={styles.comboboxItemContent}>
        <Text numberOfLines={1} style={styles.comboboxItemLabel}>{label}</Text>
        {description ? (
          <Text numberOfLines={2} style={styles.comboboxItemDescription}>{description}</Text>
        ) : null}
      </View>
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
  placeholder = "Search...",
  searchPlaceholder,
  emptyText = "No options match your search.",
  allowCustomValue = false,
  customValuePrefix = "Use",
  customValueDescription,
  title = "Select",
  open,
  onOpenChange,
  anchorRef,
  children,
}: ComboboxProps): ReactElement {
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ["60%", "90%"], []);
  const [availableSize, setAvailableSize] = useState<{ width?: number; height?: number } | null>(null);
  const [referenceWidth, setReferenceWidth] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const handleClose = useCallback(() => {
    setOpen(false);
    setSearchQuery("");
  }, [setOpen]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  const collisionPadding = useMemo(() => {
    const basePadding = 16;
    if (Platform.OS !== "android") return basePadding;
    const statusBarHeight = StatusBar.currentHeight ?? 0;
    return Math.max(basePadding, statusBarHeight + basePadding);
  }, []);

  const middleware = useMemo(
    () => [
      floatingOffset({ mainAxis: 4 }),
      flip({ padding: collisionPadding }),
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
    placement: "bottom-start",
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
    const raf = requestAnimationFrame(() => update());
    return () => cancelAnimationFrame(raf);
  }, [isMobile, update, isOpen]);

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

  const normalizedSearch = searchQuery.trim().toLowerCase();
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

  const hasMatches = filteredOptions.length > 0;
  const sanitizedSearchValue = searchQuery.trim();
  const showCustomOption =
    allowCustomValue &&
    sanitizedSearchValue.length > 0 &&
    !options.some(
      (opt) =>
        opt.id.toLowerCase() === sanitizedSearchValue.toLowerCase() ||
        opt.label.toLowerCase() === sanitizedSearchValue.toLowerCase()
    );

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

  const searchInput = (
    <SearchInput
      placeholder={searchPlaceholder ?? placeholder}
      value={searchQuery}
      onChangeText={setSearchQuery}
      onSubmitEditing={handleSubmitSearch}
      autoFocus={!isMobile}
    />
  );

  const optionsList = (
    <>
      {showCustomOption ? (
        <ComboboxItem
          label={`${customValuePrefix} "${sanitizedSearchValue}"`}
          description={customValueDescription}
          onPress={() => handleSelect(sanitizedSearchValue)}
        />
      ) : null}
      {hasMatches ? (
        filteredOptions.map((opt) => (
          <ComboboxItem
            key={opt.id}
            label={opt.label}
            description={opt.description}
            selected={opt.id === value}
            onPress={() => handleSelect(opt.id)}
          />
        ))
      ) : !showCustomOption ? (
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
      ) : null}
    </>
  );

  const content = children ?? (
    <>
      {searchInput}
      {optionsList}
    </>
  );

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
          entering={FadeIn.duration(100)}
          exiting={FadeOut.duration(100)}
          style={[
            styles.desktopContainer,
            {
              position: "absolute",
              minWidth: 200,
              width: referenceWidth ?? undefined,
            },
            floatingStyles,
            typeof availableSize?.height === "number" ? { maxHeight: Math.min(availableSize.height, 400) } : null,
            typeof availableSize?.width === "number" ? { maxWidth: availableSize.width } : null,
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
              {searchInput}
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
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[1],
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
    borderRadius: theme.borderRadius.md,
  },
  comboboxItemPressed: {
    backgroundColor: theme.colors.surface2,
  },
  comboboxItemCheckSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  comboboxItemContent: {
    flex: 1,
    flexShrink: 1,
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
    backgroundColor: theme.colors.surface2,
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
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  comboboxScrollContent: {
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[1],
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
    borderColor: theme.colors.borderAccent,
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
