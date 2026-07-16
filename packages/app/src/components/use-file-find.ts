import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView as RNScrollView,
  TextInput,
  View,
} from "react-native";
import type { HighlightToken } from "@getpaseo/highlight";
import {
  clampFileFindIndex,
  computeFileFindMatches,
  decorateFileFindLineTokens,
  groupFileFindMatchesByLine,
  stepFileFindIndex,
  type FileFindMatch,
  type FileFindToken,
} from "@/components/file-find";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useKeyboardShift } from "@/hooks/use-keyboard-shift-style";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useFileFindCapabilityStore } from "@/stores/file-find-capability-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { isWeb } from "@/constants/platform";

const FILE_FIND_ACTIONS = ["file.find"] as const;
const NO_FIND_MATCHES: readonly FileFindMatch[] = [];

/**
 * Approximate advance width of one code character as a fraction of the font
 * size, used only to scroll a match into horizontal view. The default mono
 * stacks (SF Mono, Menlo, Consolas) all sit near 0.6em; user-supplied fonts
 * and tab characters make this an estimate, so scrolling centers generously.
 */
const MONO_CHAR_WIDTH_FACTOR = 0.6;

/** Seed the find query from the current text selection (web only). */
function readFindSelectionSeed(): string | null {
  if (!isWeb || typeof window === "undefined") {
    return null;
  }
  const selection = window.getSelection?.()?.toString() ?? "";
  if (selection.length === 0 || selection.length > 200) {
    return null;
  }
  if (selection.includes("\n") || selection.trim().length === 0) {
    return null;
  }
  return selection;
}

export interface UseFileFindInput {
  /** Raw file content, or null when the pane is not showing searchable code. */
  content: string | null;
  highlightedLines: HighlightToken[][] | null;
  previewScrollRef: RefObject<RNScrollView | null>;
  gutterWidth: number;
  lineHeight: number;
  codeFontSize: number;
  contentPadding: number;
}

export interface UseFileFindResult {
  findOpen: boolean;
  findQuery: string;
  findCaseSensitive: boolean;
  matchCount: number;
  activeFindIndex: number;
  /** 1-based line of the active match, for attaching activeFindLineRef. */
  activeFindLine: number | null;
  /** Highlight lines with match segments flagged, or null without highlights. */
  displayLines: FileFindToken[][] | null;
  findInputRef: RefObject<TextInput | null>;
  /** Attach to the active match's rendered line so scrolling can measure it. */
  activeFindLineRef: RefObject<View | null>;
  horizontalScrollRef: RefObject<RNScrollView | null>;
  closeFind: () => void;
  handleFindQueryChange: (query: string) => void;
  toggleFindCaseSensitive: () => void;
  handleFindNext: () => void;
  handleFindPrevious: () => void;
  handleVerticalScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleVerticalLayout: (event: LayoutChangeEvent) => void;
  handleHorizontalScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  handleHorizontalLayout: (event: LayoutChangeEvent) => void;
}

/**
 * Find-in-file state for the file pane (#1437): owns the query and active
 * match, decorates highlight lines with match flags, claims the `file.find`
 * keyboard action while this pane is focused, and keeps the active match
 * scrolled into view.
 */
export function useFileFind(input: UseFileFindInput): UseFileFindResult {
  const {
    content,
    highlightedLines,
    previewScrollRef,
    gutterWidth,
    lineHeight,
    codeFontSize,
    contentPadding,
  } = input;

  const canFind = content !== null;
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  // Bumped on every next/previous step so the scroll effect re-runs even when
  // the active match is unchanged (single match, or wrap back to itself) —
  // Enter must still bring an off-screen match back into view.
  const [findStepNonce, setFindStepNonce] = useState(0);
  const findInputRef = useRef<TextInput>(null);
  const activeFindLineRef = useRef<View>(null);
  const horizontalScrollRef = useRef<RNScrollView>(null);
  const paneFocus = usePaneFocus();
  const { tabId } = usePaneContext();
  const isTabActive = useRetainedPanelActive();
  const handlerId = useId();
  // Pane displacement while the software keyboard is up (0 on web); the
  // keyboard overlays the pane, so this much of the viewport is not visible.
  const { shift: keyboardShift } = useKeyboardShift();

  // Close the bar when the pane stops showing searchable code (file switched
  // to markdown render / image / binary, or the preview unloaded).
  useEffect(() => {
    if (!canFind) {
      setFindOpen(false);
    }
  }, [canFind]);

  // Publish searchability so chrome outside the pane tree (the compact
  // tabs-row magnifier) can hide its trigger when find would be a no-op.
  const setTabFindable = useFileFindCapabilityStore((state) => state.setTabFindable);
  useEffect(() => {
    setTabFindable(tabId, canFind);
    return () => setTabFindable(tabId, false);
  }, [canFind, setTabFindable, tabId]);

  const contentLines = useMemo(() => {
    if (content === null) {
      return null;
    }
    // Split exactly like highlightCode so match offsets align with tokens.
    return content.split("\n");
  }, [content]);

  const findMatches = useMemo(() => {
    if (!findOpen || !contentLines || findQuery.length === 0) {
      return NO_FIND_MATCHES;
    }
    return computeFileFindMatches({
      lines: contentLines,
      query: findQuery,
      caseSensitive: findCaseSensitive,
    });
  }, [contentLines, findCaseSensitive, findOpen, findQuery]);

  const matchCount = findMatches.length;
  const activeFindIndex = clampFileFindIndex(matchCount, findIndex);
  const activeFindMatch = findMatches[activeFindIndex] ?? null;
  const findMatchesByLine = useMemo(() => groupFileFindMatchesByLine(findMatches), [findMatches]);

  // Two-layer decoration keeps line-token identities stable while stepping
  // through matches: the base layer only changes with the query/content, and
  // the active layer replaces the single active line, so CodeLine's memo
  // re-renders just the lines whose highlight actually changed.
  const matchDecoratedLines = useMemo(() => {
    if (!highlightedLines) {
      return null;
    }
    if (findMatchesByLine.size === 0) {
      return highlightedLines as FileFindToken[][];
    }
    return highlightedLines.map((tokens, index) => {
      const lineMatches = findMatchesByLine.get(index + 1);
      if (!lineMatches) {
        return tokens;
      }
      return decorateFileFindLineTokens({ tokens, matches: lineMatches, activeMatch: null });
    });
  }, [findMatchesByLine, highlightedLines]);

  const displayLines = useMemo(() => {
    if (!matchDecoratedLines || !highlightedLines || !activeFindMatch) {
      return matchDecoratedLines;
    }
    const lineIndex = activeFindMatch.line - 1;
    const originalTokens = highlightedLines[lineIndex];
    const lineMatches = findMatchesByLine.get(activeFindMatch.line);
    if (!originalTokens || !lineMatches) {
      return matchDecoratedLines;
    }
    const next = matchDecoratedLines.slice();
    next[lineIndex] = decorateFileFindLineTokens({
      tokens: originalTokens,
      matches: lineMatches,
      activeMatch: activeFindMatch,
    });
    return next;
  }, [activeFindMatch, findMatchesByLine, highlightedLines, matchDecoratedLines]);

  const openFind = useCallback(() => {
    const seed = readFindSelectionSeed();
    setFindOpen(true);
    if (seed !== null) {
      setFindQuery(seed);
      setFindIndex(0);
    }
    // The bar may not be mounted yet; match the house web focus timing (see
    // SearchInput in ui/combobox.tsx). selectTextOnFocus selects a kept query.
    setTimeout(() => findInputRef.current?.focus(), 50);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
  }, []);

  const handleFindQueryChange = useCallback((query: string) => {
    setFindQuery(query);
    setFindIndex(0);
  }, []);

  const toggleFindCaseSensitive = useCallback(() => {
    setFindCaseSensitive((current) => !current);
    // The match set changes entirely, so restart from the first match.
    setFindIndex(0);
  }, []);

  const handleFindNext = useCallback(() => {
    setFindIndex((current) => stepFileFindIndex({ count: matchCount, index: current, delta: 1 }));
    setFindStepNonce((nonce) => nonce + 1);
  }, [matchCount]);

  const handleFindPrevious = useCallback(() => {
    setFindIndex((current) => stepFileFindIndex({ count: matchCount, index: current, delta: -1 }));
    setFindStepNonce((nonce) => nonce + 1);
  }, [matchCount]);

  const isPaneInteractive = paneFocus.isInteractive;
  const isFindHandlerActive = useCallback(() => isPaneInteractive, [isPaneInteractive]);
  const handleFindAction = useCallback(
    (action: KeyboardActionDefinition) => {
      if (action.id !== "file.find" || !canFind) {
        // Not consumed: the browser's native find-in-page stays available.
        return false;
      }
      openFind();
      return true;
    },
    [canFind, openFind],
  );

  useKeyboardActionHandler({
    handlerId: `file-pane-find:${handlerId}`,
    actions: FILE_FIND_ACTIONS,
    enabled: isTabActive && paneFocus.isPaneFocused,
    priority: 0,
    isActive: isFindHandlerActive,
    handle: handleFindAction,
  });

  // Close on Escape from anywhere in this pane, not just the find input —
  // clicking into the code area (or a nav button) moves DOM focus off the
  // input, and the global Escape binding routes to agent.interrupt, never
  // here. Modal surfaces (command center, shortcuts dialog) own Escape while
  // open, and a consumed (defaultPrevented) or IME-composition Escape is
  // someone else's.
  useEffect(() => {
    if (!findOpen || !isWeb || !isPaneInteractive || !isTabActive) {
      return;
    }
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (isImeComposingKeyboardEvent(event)) {
        return;
      }
      const store = useKeyboardShortcutsStore.getState();
      if (store.commandCenterOpen || store.shortcutsDialogOpen) {
        return;
      }
      closeFind();
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [closeFind, findOpen, isPaneInteractive, isTabActive]);

  // Viewport tracking so match navigation only scrolls when the active match
  // is out of view. Refs, not state: scroll events must not re-render.
  const verticalMetricsRef = useRef({ offset: 0, viewport: 0 });
  const horizontalMetricsRef = useRef({ offset: 0, viewport: 0 });

  const handleVerticalScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    verticalMetricsRef.current.offset = event.nativeEvent.contentOffset.y;
  }, []);
  const handleVerticalLayout = useCallback((event: LayoutChangeEvent) => {
    verticalMetricsRef.current.viewport = event.nativeEvent.layout.height;
  }, []);
  const handleHorizontalScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    horizontalMetricsRef.current.offset = event.nativeEvent.contentOffset.x;
  }, []);
  const handleHorizontalLayout = useCallback((event: LayoutChangeEvent) => {
    horizontalMetricsRef.current.viewport = event.nativeEvent.layout.width;
  }, []);

  const activeFindMatchKey = activeFindMatch
    ? `${activeFindMatch.line}:${activeFindMatch.start}:${activeFindMatch.end}`
    : null;
  const activeFindMatchRef = useRef(activeFindMatch);
  activeFindMatchRef.current = activeFindMatch;

  useEffect(() => {
    if (!activeFindMatchKey) {
      return;
    }
    const match = activeFindMatchRef.current;
    if (!match) {
      return;
    }

    const scrollVerticallyTo = (matchTop: number, matchHeight: number) => {
      const vertical = verticalMetricsRef.current;
      // The software keyboard overlays the pane without resizing it, so only
      // the viewport above the keyboard counts as visible.
      const visibleViewport = vertical.viewport - Math.max(0, keyboardShift.value);
      if (visibleViewport <= 0) {
        return;
      }
      const verticalMargin = lineHeight * 2;
      const above = matchTop < vertical.offset + verticalMargin;
      const below = matchTop + matchHeight > vertical.offset + visibleViewport - verticalMargin;
      if (above || below) {
        previewScrollRef.current?.scrollTo({
          y: Math.max(0, matchTop - Math.max(verticalMargin, visibleViewport / 3)),
          animated: false,
        });
      }
    };

    // Prefer measuring the active line's rendered position: on compact
    // layouts long lines wrap, so line-number x line-height drifts. The
    // estimate stays as the fallback when measurement is unavailable.
    const estimateAndScroll = () => {
      scrollVerticallyTo(contentPadding + (match.line - 1) * lineHeight, lineHeight);
    };
    const lineNode = activeFindLineRef.current;
    // RN's ScrollView types omit getInnerViewRef; both native and RNW
    // implement it, returning the content host instance measureLayout needs.
    const innerView = (
      previewScrollRef.current as unknown as { getInnerViewRef?: () => unknown } | null
    )?.getInnerViewRef?.();
    if (lineNode && innerView != null) {
      lineNode.measureLayout(
        innerView as never,
        (_x, y, _width, height) => scrollVerticallyTo(y, height),
        estimateAndScroll,
      );
    } else {
      estimateAndScroll();
    }

    // Horizontal (desktop only — mobile wraps long lines instead).
    const horizontal = horizontalMetricsRef.current;
    const horizontalScroll = horizontalScrollRef.current;
    if (horizontalScroll && horizontal.viewport > 0) {
      const charWidth = codeFontSize * MONO_CHAR_WIDTH_FACTOR;
      const matchLeft = contentPadding + gutterWidth + match.start * charWidth;
      const matchRight = contentPadding + gutterWidth + match.end * charWidth;
      const horizontalMargin = charWidth * 8;
      const before = matchLeft < horizontal.offset + horizontalMargin;
      const after = matchRight > horizontal.offset + horizontal.viewport - horizontalMargin;
      if (before || after) {
        horizontalScroll.scrollTo({
          x: Math.max(0, matchLeft - horizontal.viewport / 3),
          animated: false,
        });
      }
    }
  }, [
    activeFindMatchKey,
    codeFontSize,
    contentPadding,
    findStepNonce,
    gutterWidth,
    keyboardShift,
    lineHeight,
    previewScrollRef,
  ]);

  return {
    findOpen,
    findQuery,
    findCaseSensitive,
    matchCount,
    activeFindIndex,
    activeFindLine: activeFindMatch?.line ?? null,
    displayLines,
    findInputRef,
    activeFindLineRef,
    horizontalScrollRef,
    closeFind,
    handleFindQueryChange,
    toggleFindCaseSensitive,
    handleFindNext,
    handleFindPrevious,
    handleVerticalScroll,
    handleVerticalLayout,
    handleHorizontalScroll,
    handleHorizontalLayout,
  };
}
