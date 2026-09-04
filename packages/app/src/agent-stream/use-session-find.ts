import { useCallback, useEffect, useId, useMemo, useState, type RefObject } from "react";
import { isWeb } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { StreamItem } from "@/types/stream";
import {
  computeSessionFindMatches,
  type SessionFindMatch,
  type SessionFindState,
} from "./find-in-session";
import type { StreamViewportHandle } from "./strategy";

const EMPTY_MATCHES: SessionFindMatch[] = [];

export interface SessionFindController {
  isOpen: boolean;
  query: string;
  matches: SessionFindMatch[];
  /** Clamped active match index; -1 when there are no matches. */
  activeIndex: number;
  focusRequestId: number;
  /** Render state for the stream strategy, or null while the bar is closed. */
  sessionFind: SessionFindState | null;
  onQueryChange: (query: string) => void;
  next: () => void;
  previous: () => void;
  close: () => void;
}

/**
 * Owns find-in-session (Cmd/Ctrl+F) state for one agent stream: the query,
 * occurrence matches over the rendered items, active-match navigation, and the
 * keyboard actions that open the bar (`agent.find`) and close it on Escape
 * (consuming `agent.interrupt` ahead of the composer's handler at 100/200).
 */
export function useSessionFind(input: {
  agentId: string;
  items: readonly StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  isPaneFocused: boolean;
  isPanelActive: boolean;
}): SessionFindController {
  const { agentId, items, viewportRef, isPaneFocused, isPanelActive } = input;
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rawActiveIndex, setRawActiveIndex] = useState(0);
  const [focusRequestId, setFocusRequestId] = useState(0);

  useEffect(() => {
    setIsOpen(false);
    setQuery("");
    setRawActiveIndex(0);
  }, [agentId]);

  const matches = useMemo(
    () => (isOpen && query ? computeSessionFindMatches(items, query) : EMPTY_MATCHES),
    [isOpen, items, query],
  );
  const activeIndex = matches.length === 0 ? -1 : Math.min(rawActiveIndex, matches.length - 1);
  const activeMatch = activeIndex >= 0 ? matches[activeIndex] : undefined;

  const sessionFind = useMemo<SessionFindState | null>(() => {
    if (!isOpen || !query) {
      return null;
    }
    const activeItemId = activeMatch?.itemId ?? null;
    return {
      query,
      activeItemId,
      activeOccurrenceIndex: activeMatch?.occurrenceIndex ?? -1,
      activeItemOccurrenceCount: activeItemId
        ? matches.filter((match) => match.itemId === activeItemId).length
        : 0,
    };
  }, [activeMatch, isOpen, matches, query]);

  const goToMatch = useCallback(
    (nextMatches: SessionFindMatch[], index: number) => {
      const match = nextMatches[index];
      if (!match) {
        return;
      }
      setRawActiveIndex(index);
      viewportRef.current?.scrollToItem?.(match.itemId);
    },
    [viewportRef],
  );

  const onQueryChange = useCallback(
    (nextQuery: string) => {
      setQuery(nextQuery);
      setRawActiveIndex(0);
      if (!nextQuery) {
        return;
      }
      goToMatch(computeSessionFindMatches(items, nextQuery), 0);
    },
    [goToMatch, items],
  );

  const next = useCallback(() => {
    if (matches.length === 0) {
      return;
    }
    goToMatch(matches, (activeIndex + 1) % matches.length);
  }, [activeIndex, goToMatch, matches]);

  const previous = useCallback(() => {
    if (matches.length === 0) {
      return;
    }
    goToMatch(matches, (activeIndex - 1 + matches.length) % matches.length);
  }, [activeIndex, goToMatch, matches]);

  const open = useCallback(() => {
    setIsOpen(true);
    setFocusRequestId((value) => value + 1);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const handlerId = useId();
  useKeyboardActionHandler({
    handlerId: `session-find-open:${handlerId}`,
    actions: ["agent.find"],
    enabled: isWeb,
    priority: 100,
    isActive: () => isPaneFocused && isPanelActive,
    handle: () => {
      open();
      return true;
    },
  });
  useKeyboardActionHandler({
    handlerId: `session-find-close:${handlerId}`,
    actions: ["agent.interrupt"],
    enabled: isWeb,
    priority: 300,
    isActive: () => isOpen && isPaneFocused && isPanelActive,
    handle: () => {
      close();
      return true;
    },
  });

  return {
    isOpen,
    query,
    matches,
    activeIndex,
    focusRequestId,
    sessionFind,
    onQueryChange,
    next,
    previous,
    close,
  };
}
