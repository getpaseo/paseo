import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";
import type {
  TimelineSearchFilter,
  TimelineSearchMatch,
  TimelineSearchState,
} from "./timeline-search-model";
import { splitHighlightSegments } from "./highlight";

const FILTERS: readonly TimelineSearchFilter[] = [
  "all",
  "prompts",
  "messages",
  "toolCalls",
  "toolOutput",
  "errors",
];

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
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TimelineSearchFilter) => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  testID?: string;
}

function MatchRow({
  match,
  index,
  active,
  query,
  onSelectIndex,
}: {
  match: TimelineSearchMatch;
  index: number;
  active: boolean;
  query: string;
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
  const segments = useMemo(
    () => splitHighlightSegments(match.snippet, query),
    [match.snippet, query],
  );

  return (
    <Pressable onPress={handlePress} style={pressableStyle}>
      <Text numberOfLines={1} style={styles.matchRowText}>
        {segments.map((segment) =>
          segment.isMatch ? (
            <Text key={segment.offset} style={styles.matchRowHighlight}>
              {segment.text}
            </Text>
          ) : (
            <React.Fragment key={segment.offset}>{segment.text}</React.Fragment>
          ),
        )}
      </Text>
    </Pressable>
  );
}

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

export function TimelineSearchPanel({
  state,
  onQueryChange,
  onFilterChange,
  onSelectNext,
  onSelectPrev,
  onSelectIndex,
  onClose,
  testID,
}: TimelineSearchPanelProps) {
  const { t } = useTranslation();

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        onClose();
        return;
      }
      if (event.nativeEvent.key === "Enter") {
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
    [onClose, onSelectNext, onSelectPrev],
  );

  const hasQuery = state.query.trim().length > 0;
  const hasMatches = state.matches.length > 0;
  const navButtonStyle = useMemo(
    () => [styles.iconButton, !hasMatches && styles.iconButtonDisabled],
    [hasMatches],
  );

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.searchRow}>
        <View style={styles.inputWrapper}>
          <ThemedSearchIcon size={16} />
          <ThemedTextInput
            value={state.query}
            onChangeText={onQueryChange}
            onKeyPress={handleKeyPress}
            placeholder={t("timelineSearch.placeholder")}
            style={styles.input}
            autoFocus
            returnKeyType="search"
            accessibilityLabel={t("timelineSearch.placeholder")}
            testID="timeline-search-input"
          />
        </View>
        {hasQuery && (
          <Text style={styles.matchCount} numberOfLines={1}>
            {hasMatches
              ? t("timelineSearch.matchCount", { count: state.matches.length })
              : t("timelineSearch.noResults")}
          </Text>
        )}
        <Pressable
          onPress={onSelectPrev}
          disabled={!hasMatches}
          accessibilityRole="button"
          accessibilityLabel={t("timelineSearch.prev")}
          style={navButtonStyle}
          testID="timeline-search-prev"
        >
          <ThemedChevronUp size={16} />
        </Pressable>
        <Pressable
          onPress={onSelectNext}
          disabled={!hasMatches}
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
            onPress={onFilterChange}
          />
        ))}
      </View>

      {hasQuery && hasMatches && (
        <ScrollView style={styles.matchList} keyboardShouldPersistTaps="handled">
          {state.matches.map((match, index) => (
            <MatchRow
              key={match.item.id}
              match={match}
              index={index}
              active={index === state.selectedIndex}
              query={state.query}
              onSelectIndex={onSelectIndex}
            />
          ))}
        </ScrollView>
      )}

      <Text style={styles.note} numberOfLines={1}>
        {t("timelineSearch.loadedHistoryNote")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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
