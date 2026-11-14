import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Text,
  View,
  Pressable,
  type ListRenderItemInfo,
  type PressableStateCallbackType,
  type ViewToken,
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
const ROW_MIN_HEIGHT = 36;
const DEFAULT_MAX_HEIGHT = 220;

const BOLT_GLYPH_PATTERN = /⚡|️/gu;

function removeBoltGlyphs(value?: string): string | undefined {
  if (!value) {
    return value;
  }
  const cleaned = value.replace(BOLT_GLYPH_PATTERN, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

interface AutocompleteRowProps {
  option: AutocompleteOption;
  isSelected: boolean;
  showArgumentHint: boolean;
  onSelect: (option: AutocompleteOption) => void;
}

const AutocompleteRow = memo(function AutocompleteRow({
  option,
  isSelected,
  showArgumentHint,
  onSelect,
}: AutocompleteRowProps) {
  const label = removeBoltGlyphs(option.label) ?? option.label;
  const description = removeBoltGlyphs(option.description);
  const argumentHint = showArgumentHint ? removeBoltGlyphs(option.argumentHint) : undefined;
  const Icon = ROW_ICONS[option.icon];
  const labelMatches = label === option.label ? option.labelMatches : undefined;

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
});

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

type ListEnd = "composer" | "far";

/**
 * The scroller a list is shown in: one for each result set, resting at one end of it. A scroller
 * starts at its resting end with only the rows nearest it, so the list opens against the composer
 * and reaches the far end when the selection wraps there without mounting the rows in between.
 * A scroller that outlived its results would keep its scroll position and its mounted rows: on
 * native a scroll command reaches the screen after the rows it was meant for.
 */
function useScroller(
  options: readonly AutocompleteOption[],
  selectedIndex: number,
): { key: string; restsAt: ListEnd } {
  const [scroller, setScroller] = useState<{
    options: readonly AutocompleteOption[];
    resultSet: number;
    restsAt: ListEnd;
  }>({ options, resultSet: 0, restsAt: "composer" });
  let next = scroller;
  if (next.options !== options) {
    next = { options, resultSet: next.resultSet + 1, restsAt: "composer" };
  }
  const restsAt = endSelected(options, selectedIndex) ?? next.restsAt;
  if (restsAt !== next.restsAt) {
    next = { ...next, restsAt };
  }
  if (next !== scroller) {
    setScroller(next);
  }
  return { key: `${next.resultSet}:${next.restsAt}`, restsAt: next.restsAt };
}

/** The end of the list the selection sits at, if it sits at one. The best match is last. */
function endSelected(
  options: readonly AutocompleteOption[],
  selectedIndex: number,
): ListEnd | null {
  if (selectedIndex === options.length - 1) return "composer";
  if (selectedIndex === 0) return "far";
  return null;
}

const FULLY_VISIBLE = { itemVisiblePercentThreshold: 100 };

function ListPadding() {
  return <View style={styles.listPadding} />;
}

function keyOfOption(option: AutocompleteOption): string {
  return option.id;
}

interface AutocompleteRowsProps {
  /** Nearest the resting end first. */
  rows: readonly AutocompleteOption[];
  selectedRow: number;
  restsAt: ListEnd;
  maxHeight: number;
  onSelect: (option: AutocompleteOption) => void;
}

/**
 * The rows, read from the end the list rests at. Against the composer the list is inverted. Either
 * way its resting scroll position is that end and the rows nearest it mount first, so a list of any
 * length opens where it rests.
 */
function AutocompleteRows({
  rows,
  selectedRow,
  restsAt,
  maxHeight,
  onSelect,
}: AutocompleteRowsProps) {
  const isCompact = useIsCompactFormFactor();
  const listRef = useRef<FlatList<AutocompleteOption>>(null);
  const fullyVisibleRows = useRef<{ first: number; last: number } | null>(null);

  // The row the keyboard selected, until it has been brought into the viewport. The row at the
  // other end is never revealed here: selecting it gives the list a scroller that rests there.
  const pendingReveal = useRef<number | null>(null);
  const isPendingRowMeasured = useRef(true);
  const revealPendingRow = useCallback(() => {
    const list = listRef.current;
    const row = pendingReveal.current;
    const visible = fullyVisibleRows.current;
    if (!list || row === null || !visible) return;
    const span = visible.last - visible.first;
    if (row >= visible.first && row <= visible.last) {
      pendingReveal.current = null;
    } else if (row === 0) {
      list.scrollToOffset({ offset: 0, animated: false });
      pendingReveal.current = null;
      fullyVisibleRows.current = { first: 0, last: span };
    } else {
      // The row comes in at the edge it was beyond.
      const isNearer = row < visible.first;
      isPendingRowMeasured.current = true;
      list.scrollToIndex({ index: row, viewPosition: isNearer ? 0 : 1, animated: false });
      // A row that has not mounted has no position yet: the list was sent towards it instead, and
      // is asked again as rows mount.
      if (!isPendingRowMeasured.current) return;
      pendingReveal.current = null;
      // The list reports what it shows after it has scrolled; the next key press may come first.
      fullyVisibleRows.current = isNearer
        ? { first: row, last: row + span }
        : { first: row - span, last: row };
    }
  }, []);
  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      isPendingRowMeasured.current = false;
      listRef.current?.scrollToOffset({
        offset: info.index * info.averageItemLength,
        animated: false,
      });
    },
    [],
  );
  useEffect(() => {
    pendingReveal.current = selectedRow < 0 ? null : selectedRow;
    revealPendingRow();
  }, [revealPendingRow, selectedRow]);

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<AutocompleteOption>[] }) => {
      const indexes = viewableItems.flatMap((token) => (token.index === null ? [] : [token.index]));
      if (indexes.length === 0) return;
      fullyVisibleRows.current = { first: Math.min(...indexes), last: Math.max(...indexes) };
      revealPendingRow();
    },
    [revealPendingRow],
  );

  // A viewport that got shorter can leave the selected row outside it.
  const handleLayout = useCallback(() => {
    // The list reports the rows its new height shows before the row is checked against them.
    listRef.current?.recordInteraction();
    pendingReveal.current = selectedRow < 0 ? null : selectedRow;
    revealPendingRow();
  }, [revealPendingRow, selectedRow]);

  const renderRow = useCallback(
    ({ item, index }: ListRenderItemInfo<AutocompleteOption>) => (
      <AutocompleteRow
        option={item}
        isSelected={index === selectedRow}
        showArgumentHint={!isCompact}
        onSelect={onSelect}
      />
    ),
    [isCompact, onSelect, selectedRow],
  );

  return (
    <FlatList
      ref={listRef}
      inverted={restsAt === "composer"}
      data={rows}
      renderItem={renderRow}
      keyExtractor={keyOfOption}
      // The first commit fills the tallest popover, so the popover never opens short and grows.
      initialNumToRender={Math.ceil(maxHeight / ROW_MIN_HEIGHT) + 1}
      removeClippedSubviews={false}
      viewabilityConfig={FULLY_VISIBLE}
      onViewableItemsChanged={handleViewableItemsChanged}
      onLayout={handleLayout}
      onContentSizeChange={revealPendingRow}
      onScrollToIndexFailed={handleScrollToIndexFailed}
      // The list's padding. As a header and footer it counts in the list's own scroll positions.
      ListHeaderComponent={ListPadding}
      ListFooterComponent={ListPadding}
      style={styles.scrollView}
      keyboardShouldPersistTaps="always"
    />
  );
}

export function Autocomplete({
  options,
  selectedIndex,
  onSelect,
  status,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: AutocompleteProps) {
  const { t } = useTranslation();
  const scroller = useScroller(options, selectedIndex);
  const rows = useMemo(
    () => (scroller.restsAt === "composer" ? options.toReversed() : options),
    [options, scroller.restsAt],
  );
  const selectedRow =
    scroller.restsAt === "composer" && selectedIndex >= 0
      ? options.length - 1 - selectedIndex
      : selectedIndex;
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
      <AutocompleteRows
        key={scroller.key}
        rows={rows}
        selectedRow={selectedRow}
        restsAt={scroller.restsAt}
        maxHeight={maxHeight}
        onSelect={onSelect}
      />
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
  listPadding: {
    height: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: ROW_MIN_HEIGHT,
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
