import { useCallback, useEffect, useRef } from "react";
import { ScrollView, Text, View, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Theme } from "@/styles/theme";
import { getAutocompleteScrollOffset } from "./autocomplete-utils";

export interface AutocompleteOption {
  id: string;
  label: string;
  detail?: string;
  description?: string;
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

export function Autocomplete({
  options,
  selectedIndex,
  onSelect,
  isLoading = false,
  errorMessage,
  loadingText = "Loading...",
  emptyText = "No results found",
  maxHeight = 220,
}: AutocompleteProps) {
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
    [ensureActiveItemVisible]
  );

  const handleRowLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      rowLayoutsRef.current.set(index, {
        top: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible]
  );

  if (isLoading) {
    return (
      <View style={[styles.container, { maxHeight }]}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{loadingText}</Text>
        </View>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={[styles.container, { maxHeight }]}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Error: {errorMessage}</Text>
        </View>
      </View>
    );
  }

  if (options.length === 0) {
    return (
      <View style={[styles.container, { maxHeight }]}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{emptyText}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { maxHeight }]}>
      <ScrollView
        ref={scrollRef}
        onLayout={handleScrollViewLayout}
        onContentSizeChange={pinToBottom}
        onScroll={(event) => {
          scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="always"
      >
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Pressable
              key={option.id}
              onLayout={(event) => handleRowLayout(index, event)}
              onPress={() => onSelect(option)}
              style={({ hovered = false, pressed }) => [
                styles.item,
                (hovered || pressed || isSelected) && styles.itemActive,
              ]}
            >
              <View style={styles.itemMain}>
                <View style={styles.itemHeader}>
                  <Text style={styles.itemLabel}>{option.label}</Text>
                  {option.detail ? (
                    <Text style={styles.itemDetail}>{option.detail}</Text>
                  ) : null}
                </View>
                {option.description ? (
                  <Text style={styles.itemDescription} numberOfLines={1}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(((theme: Theme) => ({
  container: {
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
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
  itemActive: {
    backgroundColor: theme.colors.surface1,
  },
  itemMain: {
    flex: 1,
    minWidth: 0,
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  itemLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
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
  emptyItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
})) as any) as Record<string, any>;
