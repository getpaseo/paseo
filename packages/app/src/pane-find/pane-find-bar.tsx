import React, { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react-native";
import { paneFindController } from "./pane-find-controller";
import {
  useActivePaneFindAdapter,
  usePaneFindAdapterState,
  usePaneFindFocusRequestRevision,
} from "./use-pane-find-active-state";
import type { PaneFindState } from "./pane-find-types";

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

export interface PaneFindBarViewProps {
  state: PaneFindState;
  onQueryChange: (query: string) => void;
  onSelectNext: () => void;
  onSelectPrev: () => void;
  onClose: () => void;
  inputRef?: RefObject<TextInput | null>;
  testID?: string;
}

/**
 * Presentational, generic find bar for panes that don't provide their own
 * find UI (the rich filtered timeline search panel keeps its bespoke UI and
 * is not driven by this component).
 */
export function PaneFindBarView({
  state,
  onQueryChange,
  onSelectNext,
  onSelectPrev,
  onClose,
  inputRef,
  testID,
}: PaneFindBarViewProps) {
  const { t } = useTranslation();

  const handleKeyPress = useCallback(
    (event: { nativeEvent: { key: string; shiftKey?: boolean } }) => {
      if (event.nativeEvent.key === "Escape") {
        onClose();
        return;
      }
      if (event.nativeEvent.key === "Enter") {
        // Shift+Enter navigates backwards, matching native browser find bars.
        if (event.nativeEvent.shiftKey) {
          onSelectPrev();
        } else {
          onSelectNext();
        }
      }
    },
    [onClose, onSelectNext, onSelectPrev],
  );
  const handleQueryChange = useCallback(
    (query: string) => onQueryChange(query.trim()),
    [onQueryChange],
  );

  const hasQuery = state.query.trim().length > 0;
  const hasMatches = state.matchCount > 0;
  const navButtonStyle = useMemo(
    () => [styles.iconButton, !hasMatches && styles.iconButtonDisabled],
    [hasMatches],
  );

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.inputWrapper}>
        <ThemedSearchIcon size={16} />
        <ThemedTextInput
          ref={inputRef}
          value={state.query}
          onChangeText={handleQueryChange}
          onKeyPress={handleKeyPress}
          placeholder={t("common.placeholders.search")}
          style={styles.input}
          autoFocus
          returnKeyType="search"
          accessibilityLabel={t("common.placeholders.search")}
          testID="pane-find-input"
        />
      </View>
      {hasQuery && !state.isPending && (
        <Text style={styles.matchCount} numberOfLines={1}>
          {hasMatches
            ? t("paneFind.matchCount", { count: state.matchCount })
            : t("paneFind.noMatches")}
        </Text>
      )}
      <Pressable
        onPress={onSelectPrev}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={t("paneFind.prev")}
        style={navButtonStyle}
        testID="pane-find-prev"
      >
        <ThemedChevronUp size={16} />
      </Pressable>
      <Pressable
        onPress={onSelectNext}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={t("paneFind.next")}
        style={navButtonStyle}
        testID="pane-find-next"
      >
        <ThemedChevronDown size={16} />
      </Pressable>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t("common.actions.close")}
        style={styles.iconButton}
        testID="pane-find-close"
      >
        <ThemedCloseIcon size={16} />
      </Pressable>
    </View>
  );
}

/**
 * Connected shared find bar: reads the focused pane's adapter from the
 * pane-find registry and renders nothing when no pane is focused, or when
 * the focused pane provides its own find UI (`hasCustomUI`).
 */
export function PaneFindBar({ testID }: { testID?: string }) {
  const adapter = useActivePaneFindAdapter();
  const state = usePaneFindAdapterState(adapter);
  const focusRequestRevision = usePaneFindFocusRequestRevision();
  const inputRef = useRef<TextInput>(null);
  const queryRef = useRef(state?.query ?? "");
  queryRef.current = state?.query ?? "";

  useEffect(() => {
    if (paneFindController.getActiveAdapter() !== adapter || !adapter?.getState().isOpen) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (typeof input.setNativeProps === "function") {
      input.setNativeProps({
        selection: { start: 0, end: queryRef.current.length },
      });
      return;
    }
    // React Native Web exposes a DOM input ref in browser tests and Electron.
    if ("select" in input && typeof input.select === "function") {
      input.select();
    }
  }, [adapter, focusRequestRevision]);

  const handleQueryChange = useCallback((query: string) => adapter?.setQuery(query), [adapter]);
  const handleSelectNext = useCallback(() => adapter?.selectNext(), [adapter]);
  const handleSelectPrev = useCallback(() => adapter?.selectPrev(), [adapter]);
  const handleClose = useCallback(() => adapter?.close(), [adapter]);

  if (!adapter || adapter.hasCustomUI || !state || !state.isOpen) {
    return null;
  }

  return (
    <PaneFindBarView
      state={state}
      onQueryChange={handleQueryChange}
      onSelectNext={handleSelectNext}
      onSelectPrev={handleSelectPrev}
      onClose={handleClose}
      inputRef={inputRef}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  input: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
    outlineWidth: 0,
  },
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
}));
