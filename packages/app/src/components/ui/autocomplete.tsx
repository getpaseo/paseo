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
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Archive,
  CircleAlert,
  File,
  Folder,
  Puzzle,
  RotateCw,
  Sparkles,
  SquarePen,
  SquareSlash,
} from "lucide-react-native";
import type { MatchRange } from "@getpaseo/protocol/search/text-match";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { Button } from "./button";
import { HighlightedText } from "./highlighted-text";
import { mutedIconColorMapping } from "./icon-color";
import { LoadingSpinner } from "./loading-spinner";
import { getScrollOffsetToRevealItem } from "./scroll-reveal";
import { StatusBadge } from "./status-badge";

export type AutocompleteOptionIcon =
  | "command"
  | "skill"
  | "plugin"
  | "archive"
  | "new-draft"
  | "file"
  | "directory";

export interface AutocompleteOption {
  id: string;
  label: string;
  icon: AutocompleteOptionIcon;
  /** Spans of `label` the query matched. */
  labelMatches?: readonly MatchRange[];
  argumentHint?: string;
  description?: string;
  /** Where the option comes from, when that is not the provider itself: `Skill`, `Paseo`, a plugin. */
  tag?: string;
}

/** What the list shows in place of options. */
export type AutocompleteStatus =
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; title: string; reason?: string; onRetry?: () => void };

interface AutocompleteProps {
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  status?: AutocompleteStatus | null;
  maxHeight?: number;
}

const ROW_ICONS = {
  command: withUnistyles(SquareSlash, mutedIconColorMapping),
  skill: withUnistyles(Sparkles, mutedIconColorMapping),
  plugin: withUnistyles(Puzzle, mutedIconColorMapping),
  archive: withUnistyles(Archive, mutedIconColorMapping),
  "new-draft": withUnistyles(SquarePen, mutedIconColorMapping),
  file: withUnistyles(File, mutedIconColorMapping),
  directory: withUnistyles(Folder, mutedIconColorMapping),
} satisfies Record<AutocompleteOptionIcon, unknown>;
const ErrorIcon = withUnistyles(CircleAlert, mutedIconColorMapping);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, mutedIconColorMapping);

const ROW_ICON_SIZE = 14;

const BOLT_GLYPH_PATTERN = /⚡|️/gu;

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
  showArgumentHint: boolean;
  onSelect: (option: AutocompleteOption) => void;
  onRowLayout: (index: number, event: LayoutChangeEvent) => void;
}

function AutocompleteRow({
  index,
  option,
  isSelected,
  showArgumentHint,
  onSelect,
  onRowLayout,
}: AutocompleteRowProps) {
  const label = removeBoltGlyphs(option.label) ?? option.label;
  const description = removeBoltGlyphs(option.description);
  const argumentHint = showArgumentHint ? removeBoltGlyphs(option.argumentHint) : undefined;
  const Icon = ROW_ICONS[option.icon];
  const labelMatches = label === option.label ? option.labelMatches : undefined;

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
    <Pressable
      onLayout={handleLayout}
      onPress={handlePress}
      style={pressableStyle}
      // Name and description only; the hint and tag repeat what the name implies.
      accessibilityLabel={description ? `${label}, ${description}` : label}
    >
      <View style={styles.itemIcon}>
        <Icon size={ROW_ICON_SIZE} />
      </View>
      <HighlightedText
        text={label}
        ranges={labelMatches}
        style={styles.itemLabel}
        numberOfLines={1}
      />
      {argumentHint ? (
        <Text style={styles.itemArgumentHint} numberOfLines={1}>
          {argumentHint}
        </Text>
      ) : null}
      <Text style={styles.itemDescription} numberOfLines={1}>
        {description ?? ""}
      </Text>
      {option.tag ? <StatusBadge label={option.tag} size="xs" /> : null}
    </Pressable>
  );
}

function AutocompleteStatusRow({ status }: { status: AutocompleteStatus }) {
  const { t } = useTranslation();

  if (status.kind === "error") {
    return (
      <View style={styles.statusRow} testID="composer-autocomplete-error">
        <View style={styles.itemIcon}>
          <ErrorIcon size={ROW_ICON_SIZE} />
        </View>
        <View style={styles.statusText}>
          <Text style={styles.statusTitle} numberOfLines={2}>
            {status.title}
          </Text>
          {status.reason ? (
            <Text style={styles.statusReason} numberOfLines={2}>
              {status.reason}
            </Text>
          ) : null}
        </View>
        {status.onRetry ? (
          <Button variant="secondary" size="sm" leftIcon={RotateCw} onPress={status.onRetry}>
            {t("common.actions.retry")}
          </Button>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={styles.statusRow}
      testID={status.kind === "loading" ? "composer-autocomplete-loading" : undefined}
    >
      {status.kind === "loading" ? (
        <View style={styles.itemIcon}>
          <ThemedLoadingSpinner size={ROW_ICON_SIZE} />
        </View>
      ) : null}
      <Text style={styles.statusMessage} numberOfLines={2}>
        {status.message}
      </Text>
    </View>
  );
}

export function Autocomplete({
  options,
  selectedIndex,
  onSelect,
  status,
  maxHeight = 220,
}: AutocompleteProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
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

    const nextOffset = getScrollOffsetToRevealItem({
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

  const containerStyle = useMemo(() => [styles.container, { maxHeight }], [maxHeight]);

  const noResultsMessage = t("common.empty.noResults");
  const shownStatus = useMemo<AutocompleteStatus | null>(
    () => status ?? (options.length === 0 ? { kind: "empty", message: noResultsMessage } : null),
    [noResultsMessage, options.length, status],
  );

  if (shownStatus) {
    return (
      <View style={containerStyle}>
        <AutocompleteStatusRow status={shownStatus} />
      </View>
    );
  }

  return (
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
            showArgumentHint={!isCompact}
            onSelect={onSelect}
            onRowLayout={handleRowLayout}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexShrink: 1,
    // Keep a complete selectable row (36), list padding (8), and borders (2).
    minHeight: 46,
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
    gap: theme.spacing[2],
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemActive: {
    backgroundColor: theme.colors.surface2,
  },
  itemIcon: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  itemLabel: {
    flexShrink: 0,
    maxWidth: "60%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  itemArgumentHint: {
    flexShrink: 0,
    maxWidth: "30%",
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  itemDescription: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  statusText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  statusTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  statusReason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusMessage: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
})) as unknown as Record<string, object>;
