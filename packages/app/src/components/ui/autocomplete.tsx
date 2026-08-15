import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ScrollView,
  Text,
  View,
  Pressable,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { File, Folder } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { getAutocompleteScrollOffset } from "./autocomplete-utils";

export interface AutocompleteOption {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  kind?: "command" | "file" | "directory" | "history";
}

interface AutocompleteProps {
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  isLoading?: boolean;
  errorMessage?: string;
  loadingText?: string;
  emptyText?: string;
  maxHeight?: number;
}

const BOLT_GLYPH_PATTERN = /\u26A1|\uFE0F/gu;

function removeBoltGlyphs(value?: string): string | undefined {
  if (!value) {
    return value;
  }
  const cleaned = value.replace(BOLT_GLYPH_PATTERN, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

interface AutocompleteRowProps {
  index: number;
  option: AutocompleteOption;
  isSelected: boolean;
  mutedColor: string;
  onSelect: (option: AutocompleteOption) => void;
  onRowLayout: (index: number, event: LayoutChangeEvent) => void;
}

function AutocompleteRow({
  index,
  option,
  isSelected,
  mutedColor,
  onSelect,
  onRowLayout,
}: AutocompleteRowProps) {
  const optionLabel = removeBoltGlyphs(option.label) ?? option.label;
  const optionDescription = removeBoltGlyphs(option.description);
  const isFileOrDir = option.kind === "directory" || option.kind === "file";

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onRowLayout(index, event),
    [index, onRowLayout],
  );
  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.item,
      (hovered || pressed || isSelected) && styles.itemActive,
    ],
    [isSelected],
  );

  return (
    <Pressable onLayout={handleLayout} onPress={handlePress} style={pressableStyle}>
      {isFileOrDir ? (
        <>
          <View style={styles.itemLeading}>
            {option.kind === "directory" ? (
              <Folder size={14} color={mutedColor} />
            ) : (
              <File size={14} color={mutedColor} />
            )}
          </View>
          <View style={styles.itemMain}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemLabel}>{optionLabel}</Text>
              {removeBoltGlyphs(option.detail) ? (
                <Text style={styles.itemDetail}>{removeBoltGlyphs(option.detail)}</Text>
              ) : null}
            </View>
            {optionDescription ? (
              <Text style={styles.itemDescription} numberOfLines={1}>
                {optionDescription}
              </Text>
            ) : null}
          </View>
        </>
      ) : (
        <View style={styles.itemMainRow}>
          <Text
            style={!optionDescription ? styles.itemLabelFill : styles.itemLabel}
            numberOfLines={1}
          >
            {optionLabel}
          </Text>
          {optionDescription ? (
            <Text style={styles.itemDescriptionInline} numberOfLines={1}>
              {optionDescription}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function Autocomplete({
  options,
  selectedIndex,
  onSelect,
  isLoading = false,
  errorMessage,
  loadingText,
  emptyText,
  maxHeight = 220,
}: AutocompleteProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const resolvedLoadingText = loadingText ?? t("common.states.loading");
  const resolvedEmptyText = emptyText ?? t("common.empty.noResults");
  const scrollRef = useRef<ScrollView>(null);
  const rowLayoutsRef = useRef<Map<number, { top: number; height: number }>>(new Map());
  const viewportHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);

  const ensureActiveItemVisible = useCallback(() => {
    if (selectedIndex < 0) {
      return;
    }

    const layout = rowLayoutsRef.current.get(selectedIndex);
    if (!layout) {
      return;
    }

    const nextOffset = getAutocompleteScrollOffset({
      currentOffset: scrollOffsetRef.current,
      viewportHeight: viewportHeightRef.current,
      itemTop: layout.top,
      itemHeight: layout.height,
    });

    if (Math.abs(nextOffset - scrollOffsetRef.current) < 1) {
      return;
    }

    scrollOffsetRef.current = nextOffset;
    scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
  }, [selectedIndex]);

  const pinToBottom = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
  }, []);

  useEffect(() => {
    rowLayoutsRef.current.clear();
    scrollOffsetRef.current = 0;
  }, [options]);

  useEffect(() => {
    if (options.length === 0) {
      return;
    }
    pinToBottom();
  }, [options, pinToBottom]);

  useEffect(() => {
    const raf = requestAnimationFrame(ensureActiveItemVisible);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [ensureActiveItemVisible, options.length]);

  const handleScrollViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible],
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const handleRowLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      rowLayoutsRef.current.set(index, {
        top: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible],
  );

  const selectedOption = options[selectedIndex];
  const containerStyle = useMemo(() => [styles.container, { maxHeight }], [maxHeight]);

  if (isLoading) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{resolvedLoadingText}</Text>
        </View>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Error: {errorMessage}</Text>
        </View>
      </View>
    );
  }

  if (options.length === 0) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{resolvedEmptyText}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.outerWrapper}>
      <AutocompleteDetail
        option={selectedOption}
        selectedIndex={selectedIndex}
        total={options.length}
      />
      <View style={containerStyle}>
        <ScrollView
          ref={scrollRef}
          onLayout={handleScrollViewLayout}
          onContentSizeChange={pinToBottom}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="always"
        >
          {options.map((option, index) => (
            <AutocompleteRow
              key={option.id}
              index={index}
              option={option}
              isSelected={index === selectedIndex}
              mutedColor={theme.colors.foregroundMuted}
              onSelect={onSelect}
              onRowLayout={handleRowLayout}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  outerWrapper: {
    gap: theme.spacing[1],
  },
  detailCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    ...theme.shadow.md,
  },
  detailLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  detailDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  detailHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  container: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  scrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemLeading: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  itemActive: {
    backgroundColor: theme.colors.surface2,
  },
  itemMain: {
    flex: 1,
    minWidth: 0,
  },
  itemMainRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  itemLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  // When a row has no description (e.g. message history), let the label fill the
  // row so numberOfLines={1} truncates with an ellipsis instead of overflowing.
  itemLabelFill: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
  },
  itemDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  itemDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  itemDescriptionInline: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
})) as unknown as Record<string, object>;

/**
 * Preview panel above the list for the selected option. Commands (skills) show
 * their name and description; history messages show the selected position
 * (e.g. "2 / 5") as the header and the full message text below, so a row that
 * was truncated to one line can still be read in full.
 */
function AutocompleteDetail({
  option,
  selectedIndex,
  total,
}: {
  option: AutocompleteOption | undefined;
  selectedIndex: number;
  total: number;
}) {
  if (!option) {
    return null;
  }
  if (option.kind === "command" && option.description) {
    return (
      <View style={styles.detailCard}>
        <Text style={styles.detailLabel}>{removeBoltGlyphs(option.label) ?? option.label}</Text>
        <Text style={styles.detailDescription}>{removeBoltGlyphs(option.description)}</Text>
        {option.detail ? (
          <Text style={styles.detailHint}>{removeBoltGlyphs(option.detail)}</Text>
        ) : null}
      </View>
    );
  }
  if (option.kind === "history") {
    return (
      <View style={styles.detailCard}>
        <Text style={styles.detailLabel}>
          {selectedIndex + 1} / {total}
        </Text>
        <Text style={styles.detailDescription}>
          {removeBoltGlyphs(option.label) ?? option.label}
        </Text>
      </View>
    );
  }
  return null;
}
