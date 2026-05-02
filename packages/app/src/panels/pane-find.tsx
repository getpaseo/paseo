import { ChevronDown, ChevronUp, X } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useStableEvent } from "@/hooks/use-stable-event";
import { usePaneContext } from "@/panels/pane-context";
import { paneFindRegistry } from "@/panels/pane-find-registry";

export type PaneFindMatchState =
  | { status: "empty" }
  | { status: "pending" }
  | { status: "no-match" }
  | { status: "matched"; current: number; total: number };

export type PaneFindCommandResult = PaneFindMatchState | void;

export interface UsePaneFindInput {
  matchState?: PaneFindMatchState;
  onQuery(query: string): PaneFindCommandResult;
  onNext(): PaneFindCommandResult;
  onPrev(): PaneFindCommandResult;
  onClose(): void;
}

export interface FindBarProps {
  query: string;
  matchState: PaneFindMatchState;
  focusToken: number;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
}

export interface UsePaneFindResult {
  isOpen: boolean;
  findBarProps: FindBarProps;
}

export function usePaneFind(input: UsePaneFindInput): UsePaneFindResult {
  const { paneInstanceId } = usePaneContext();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchState, setMatchState] = useState<PaneFindMatchState>({ status: "empty" });
  const [focusToken, setFocusToken] = useState(0);
  const onQuery = useStableEvent(input.onQuery);
  const onNextInput = useStableEvent(input.onNext);
  const onPrevInput = useStableEvent(input.onPrev);
  const onCloseInput = useStableEvent(input.onClose);
  const isOpenRef = useRef(false);
  const queryRef = useRef("");

  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!isOpen || !input.matchState) {
      return;
    }
    setMatchState(input.matchState);
  }, [input.matchState, isOpen]);

  const openFind = useCallback(() => {
    isOpenRef.current = true;
    setIsOpen(true);
    setFocusToken((current) => current + 1);
    return true;
  }, []);

  const closeFind = useCallback(() => {
    if (!isOpenRef.current && queryRef.current.length === 0) {
      return false;
    }
    isOpenRef.current = false;
    queryRef.current = "";
    setIsOpen(false);
    setQuery("");
    setMatchState({ status: "empty" });
    onCloseInput();
    return true;
  }, [onCloseInput]);

  useEffect(() => {
    if (!paneInstanceId) {
      return;
    }
    return paneFindRegistry.register({
      paneId: paneInstanceId,
      controller: { openFind, closeFind },
    });
  }, [closeFind, openFind, paneInstanceId]);

  useEffect(() => {
    return () => {
      closeFind();
    };
  }, [closeFind]);

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      queryRef.current = nextQuery;
      setQuery(nextQuery);
      const nextState = onQuery(nextQuery);
      setMatchState(
        nextQuery.length === 0 ? { status: "empty" } : (nextState ?? { status: "pending" }),
      );
    },
    [onQuery],
  );

  const handleNext = useCallback(() => {
    if (queryRef.current.length === 0) {
      return;
    }
    setMatchState(onNextInput() ?? { status: "pending" });
  }, [onNextInput]);

  const handlePrev = useCallback(() => {
    if (queryRef.current.length === 0) {
      return;
    }
    setMatchState(onPrevInput() ?? { status: "pending" });
  }, [onPrevInput]);

  const handleClose = useCallback(() => {
    closeFind();
  }, [closeFind]);

  const findBarProps = useMemo(
    () => ({
      query,
      matchState,
      focusToken,
      onQueryChange: handleQueryChange,
      onNext: handleNext,
      onPrev: handlePrev,
      onClose: handleClose,
    }),
    [focusToken, handleClose, handleNext, handlePrev, handleQueryChange, matchState, query],
  );

  return { isOpen, findBarProps };
}

export function FindBar({
  query,
  matchState,
  focusToken,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<TextInput>(null);
  const { theme } = useUnistyles();
  const iconColor = theme.colors?.foregroundMuted ?? "#71717a";

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusToken]);

  const canNavigate = matchState.status === "matched";
  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData & { shiftKey?: boolean }>) => {
      if (event.nativeEvent.key === "Escape") {
        event.preventDefault?.();
        onClose();
        return;
      }
      if (event.nativeEvent.key !== "Enter") {
        return;
      }
      event.preventDefault?.();
      if (!canNavigate) {
        return;
      }
      if (event.nativeEvent.shiftKey) {
        onPrev();
        return;
      }
      onNext();
    },
    [canNavigate, onClose, onNext, onPrev],
  );

  const counterText = formatMatchState(matchState);
  const controlDisabled = !canNavigate;
  const matchButtonStyle = useMemo(
    () => [styles.iconButton, controlDisabled && styles.iconButtonDisabled],
    [controlDisabled],
  );

  return (
    <View style={styles.container} testID="pane-find-bar">
      <Text style={styles.label}>Find</Text>
      <TextInput
        ref={inputRef}
        testID="pane-find-input"
        value={query}
        onChangeText={onQueryChange}
        onKeyPress={handleKeyPress}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Search"
        placeholderTextColor={theme.colors?.foregroundMuted ?? "#71717a"}
        style={styles.input}
      />
      <Text style={styles.counter}>{counterText}</Text>
      <Pressable
        accessibilityLabel="Previous match"
        disabled={controlDisabled}
        onPress={onPrev}
        style={matchButtonStyle}
        testID="pane-find-prev"
      >
        <ChevronUp size={14} color={iconColor} />
      </Pressable>
      <Pressable
        accessibilityLabel="Next match"
        disabled={controlDisabled}
        onPress={onNext}
        style={matchButtonStyle}
        testID="pane-find-next"
      >
        <ChevronDown size={14} color={iconColor} />
      </Pressable>
      <Pressable
        accessibilityLabel="Close find"
        onPress={onClose}
        style={styles.iconButton}
        testID="pane-find-close"
      >
        <X size={14} color={iconColor} />
      </Pressable>
    </View>
  );
}

function formatMatchState(matchState: PaneFindMatchState): string {
  if (matchState.status === "matched") {
    return `${matchState.current} / ${matchState.total}`;
  }
  if (matchState.status === "no-match") {
    return "No matches";
  }
  if (matchState.status === "pending") {
    return "Searching...";
  }
  return "0 / 0";
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    flex: 1,
    minWidth: 120,
    height: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: 6,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    fontSize: 13,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  counter: {
    minWidth: 64,
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    textAlign: "right",
  },
  iconButton: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
}));
