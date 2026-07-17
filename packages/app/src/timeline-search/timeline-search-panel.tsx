import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";
import { FIND_INPUT_FOCUS_SCOPE } from "@/keyboard/focus-scope";
import {
  MAX_TIMELINE_SEARCH_MATCHES,
  type TimelineSearchFilter,
  type TimelineSearchMatch,
  type TimelineSearchState,
} from "./timeline-search-model";

const FILTERS: readonly TimelineSearchFilter[] = [
  "all",
  "prompts",
  "messages",
  "thinking",
  "toolCalls",
  "toolOutput",
  "errors",
];

/**
 * Keystroke → search debounce. Every committed query change re-searches the
 * full loaded history AND re-renders every mounted message's highlighting, so
 * on large threads committing per keystroke is the dominant typing cost.
 */
const QUERY_DEBOUNCE_MS = 150;

const ThemedSearchIcon = withUnistyles(Search, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedCloseIcon = withUnistyles(X, (theme) => ({ color: theme.colors.foreground }));
const ThemedChevronUp = withUnistyles(ChevronUp, (theme) => ({ color: theme.colors.foreground }));
const ThemedChevronDown = withUnistyles(ChevronDown, (theme) => ({
  color: theme.colors.foreground,
}));
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export interface TimelineSearchPanelProps {
  state: TimelineSearchState;
  /**
   * True while older history is still being paged in for the current query.
   * Drives a "searching history" pending state so an incomplete result set
   * isn't shown as a final "no results".
   */
  isPaging?: boolean;
  /**
   * True when older-history paging gave up (repeated loads made no progress).
   * Shows a note so partial results aren't mistaken for complete ones.
   */
  historyLoadFailed?: boolean;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TimelineSearchFilter) => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  testID?: string;
}

const MatchRow = React.memo(function MatchRow({
  match,
  index,
  active,
  onSelectIndex,
}: {
  match: TimelineSearchMatch;
  index: number;
  active: boolean;
  onSelectIndex: (index: number) => void;
}) {
  const handlePress = useCallback(() => onSelectIndex(index), [onSelectIndex, index]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.matchRow,
      (active || Boolean(hovered) || pressed) && styles.matchRowActive,
    ],
    [active],
  );
  const snippetParts = useMemo(() => {
    const start = Math.min(Math.max(match.snippetMatchOffset, 0), match.snippet.length);
    const end = Math.min(start + match.snippetMatchLength, match.snippet.length);
    return {
      before: match.snippet.slice(0, start),
      match: match.snippet.slice(start, end),
      after: match.snippet.slice(end),
    };
  }, [match.snippet, match.snippetMatchLength, match.snippetMatchOffset]);

  return (
    <Pressable onPress={handlePress} style={pressableStyle}>
      <Text numberOfLines={1} style={styles.matchRowText}>
        {snippetParts.before}
        {snippetParts.match ? (
          <Text style={styles.matchRowHighlight}>{snippetParts.match}</Text>
        ) : null}
        {snippetParts.after}
      </Text>
    </Pressable>
  );
});

function FilterChip({
  filter,
  active,
  label,
  onPress,
}: {
  filter: TimelineSearchFilter;
  active: boolean;
  label: string;
  onPress: (filter: TimelineSearchFilter) => void;
}) {
  const handlePress = useCallback(() => onPress(filter), [onPress, filter]);
  const chipStyle = useMemo(() => [styles.filterChip, active && styles.filterChipActive], [active]);
  const textStyle = useMemo(
    () => [styles.filterChipText, active && styles.filterChipTextActive],
    [active],
  );

  return (
    <Pressable onPress={handlePress} style={chipStyle} testID={`timeline-search-filter-${filter}`}>
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

// oxlint-disable-next-line max-lines-per-function
export function TimelineSearchPanel({
  state,
  isPaging = false,
  historyLoadFailed = false,
  onQueryChange,
  onFilterChange,
  onSelectNext,
  onSelectPrev,
  onSelectIndex,
  onClose,
  testID,
}: TimelineSearchPanelProps) {
  const { t } = useTranslation();

  // The input edits a local draft that commits to the model after a short
  // debounce (or immediately on clear/Enter), so typing doesn't re-search the
  // whole thread and re-render every message's highlight per keystroke.
  const [draftQuery, setDraftQuery] = useState(state.query);
  const findInputDataSet = useMemo(() => ({ paseoKeyboardFocusScope: FIND_INPUT_FOCUS_SCOPE }), []);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentQueryRef = useRef(state.query);

  // External query changes (persisted restore, adapter setQuery) sync into the
  // draft; changes we sent ourselves are already reflected there.
  useEffect(() => {
    if (state.query !== lastSentQueryRef.current) {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      lastSentQueryRef.current = state.query;
      setDraftQuery(state.query);
    }
  }, [state.query]);

  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    },
    [],
  );

  const commitQuery = useCallback(
    (query: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (query === lastSentQueryRef.current) {
        return;
      }
      lastSentQueryRef.current = query;
      onQueryChange(query);
    },
    [onQueryChange],
  );

  const handleChangeText = useCallback(
    (query: string) => {
      setDraftQuery(query);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      // Clearing should feel instant (it also stops history paging).
      if (query.trim().length === 0) {
        commitQuery(query);
        return;
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        commitQuery(query);
      }, QUERY_DEBOUNCE_MS);
    },
    [commitQuery],
  );

  /** Commits a pending (debounced) draft immediately. True if it committed. */
  const flushPendingQuery = useCallback((): boolean => {
    const wasPending = debounceRef.current !== null;
    if (!wasPending) {
      return false;
    }
    clearTimeout(debounceRef.current as ReturnType<typeof setTimeout>);
    debounceRef.current = null;
    if (draftQuery === lastSentQueryRef.current) {
      return false;
    }
    lastSentQueryRef.current = draftQuery;
    onQueryChange(draftQuery);
    return true;
  }, [draftQuery, onQueryChange]);

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        onClose();
        return;
      }
      if (event.nativeEvent.key === "Enter") {
        // Enter with an uncommitted draft searches it now (landing on the
        // first match) rather than stepping through stale results.
        if (flushPendingQuery()) {
          return;
        }
        // Shift+Enter steps backwards, matching native find bars and the shared
        // PaneFindBar. `shiftKey` is present on the web nativeEvent but not in
        // the RN TextInputKeyPressEventData type.
        if ((event.nativeEvent as { shiftKey?: boolean }).shiftKey) {
          onSelectPrev();
        } else {
          onSelectNext();
        }
      }
    },
    [onClose, onSelectNext, onSelectPrev, flushPendingQuery],
  );

  const handleSelectNext = useCallback(() => {
    if (!flushPendingQuery()) onSelectNext();
  }, [flushPendingQuery, onSelectNext]);
  const handleSelectPrev = useCallback(() => {
    if (!flushPendingQuery()) onSelectPrev();
  }, [flushPendingQuery, onSelectPrev]);
  const handleFilterChange = useCallback(
    (filter: TimelineSearchFilter) => {
      flushPendingQuery();
      onFilterChange(filter);
    },
    [flushPendingQuery, onFilterChange],
  );

  const hasQuery = state.query.trim().length > 0;
  const hasMatches = state.matches.length > 0;
  const hasPendingQuery = draftQuery !== lastSentQueryRef.current;
  const canNavigate = hasMatches || hasPendingQuery;
  const navButtonStyle = useMemo(
    () => [styles.iconButton, !canNavigate && styles.iconButtonDisabled],
    [canNavigate],
  );

  // While older history is still paging in, show a pending status rather than a
  // premature "no results"; otherwise the (possibly capped) match count.
  let matchStatusLabel: string;
  if (isPaging) {
    matchStatusLabel = t("timelineSearch.searchingHistory");
  } else if (state.isMatchLimitExceeded) {
    matchStatusLabel = t("timelineSearch.matchCountCapped", {
      count: MAX_TIMELINE_SEARCH_MATCHES,
    });
  } else if (hasMatches) {
    matchStatusLabel = t("timelineSearch.matchCount", { count: state.matches.length });
  } else {
    matchStatusLabel = t("timelineSearch.noResults");
  }

  // Virtualized result list: per-occurrence matching means thousands of rows on
  // broad queries — mounting them all in a ScrollView is the other major
  // large-thread cost. Keep the active row visible while cycling.
  const listRef = useRef<FlatList<TimelineSearchMatch>>(null);
  const scrollRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderMatchRow = useCallback(
    ({ item, index }: ListRenderItemInfo<TimelineSearchMatch>) => (
      <MatchRow
        match={item}
        index={index}
        active={index === state.selectedIndex}
        onSelectIndex={onSelectIndex}
      />
    ),
    [state.selectedIndex, onSelectIndex],
  );
  const keyExtractor = useCallback(
    (match: TimelineSearchMatch) => `${match.item.id}:${match.matchOffset}`,
    [],
  );
  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      // Row not rendered yet — jump near it; FlatList fills in around it.
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: false,
      });
      if (scrollRetryRef.current) clearTimeout(scrollRetryRef.current);
      scrollRetryRef.current = setTimeout(() => {
        scrollRetryRef.current = null;
        try {
          listRef.current?.scrollToIndex({
            index: info.index,
            viewPosition: 0.5,
            animated: false,
          });
        } catch {
          // The data may have changed while the retry was queued.
        }
      }, 50);
    },
    [],
  );
  useEffect(
    () => () => {
      if (scrollRetryRef.current) clearTimeout(scrollRetryRef.current);
    },
    [],
  );
  useEffect(() => {
    if (state.selectedIndex < 0) {
      return;
    }
    const index = state.selectedIndex;
    const frame = requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
      } catch {
        // Index briefly out of range while a refresh replaces the matches.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [state.selectedIndex, state.navigationRevision]);

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.searchRow}>
        <View style={styles.inputWrapper}>
          <ThemedSearchIcon size={16} />
          <ThemedTextInput
            value={draftQuery}
            onChangeText={handleChangeText}
            onKeyPress={handleKeyPress}
            placeholder={t("timelineSearch.placeholder")}
            style={styles.input}
            autoFocus
            returnKeyType="search"
            accessibilityLabel={t("timelineSearch.placeholder")}
            dataSet={findInputDataSet}
            testID="timeline-search-input"
          />
        </View>
        {hasQuery && (
          <Text style={styles.matchCount} numberOfLines={1}>
            {matchStatusLabel}
          </Text>
        )}
        <Pressable
          onPress={handleSelectPrev}
          disabled={!canNavigate}
          accessibilityRole="button"
          accessibilityLabel={t("timelineSearch.prev")}
          style={navButtonStyle}
          testID="timeline-search-prev"
        >
          <ThemedChevronUp size={16} />
        </Pressable>
        <Pressable
          onPress={handleSelectNext}
          disabled={!canNavigate}
          accessibilityRole="button"
          accessibilityLabel={t("timelineSearch.next")}
          style={navButtonStyle}
          testID="timeline-search-next"
        >
          <ThemedChevronDown size={16} />
        </Pressable>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("timelineSearch.close")}
          style={styles.iconButton}
          testID="timeline-search-close"
        >
          <ThemedCloseIcon size={16} />
        </Pressable>
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((filter) => (
          <FilterChip
            key={filter}
            filter={filter}
            active={state.filter === filter}
            label={t(`timelineSearch.filters.${filter}`)}
            onPress={handleFilterChange}
          />
        ))}
      </View>

      {hasQuery && hasMatches && (
        <FlatList
          ref={listRef}
          style={styles.matchList}
          data={state.matches}
          renderItem={renderMatchRow}
          keyExtractor={keyExtractor}
          extraData={state.selectedIndex}
          keyboardShouldPersistTaps="handled"
          onScrollToIndexFailed={handleScrollToIndexFailed}
          initialNumToRender={12}
        />
      )}

      {isPaging && (
        <Text style={styles.note} numberOfLines={1}>
          {t("timelineSearch.loadingOlderHistory")}
        </Text>
      )}
      {!isPaging && historyLoadFailed && (
        <Text style={styles.note} numberOfLines={1} testID="timeline-search-history-failed">
          {t("timelineSearch.historyLoadFailed")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[1],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Accent-bordered field wrapping the magnifier icon + text input so it's
  // clear where to type.
  inputWrapper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1.5,
    borderColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
    // Remove the browser's native focus ring so only the accent field border
    // shows (otherwise there are two boxes on focus).
    outlineWidth: 0,
  },
  matchCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginRight: theme.spacing[1],
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  filterChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1] / 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  filterChipActive: {
    backgroundColor: theme.colors.accent,
  },
  filterChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  filterChipTextActive: {
    color: theme.colors.accentForeground,
  },
  matchList: {
    maxHeight: 220,
  },
  matchRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  matchRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  matchRowText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  matchRowHighlight: {
    color: theme.colors.accent,
    fontWeight: theme.fontWeight.semibold,
  },
  note: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
