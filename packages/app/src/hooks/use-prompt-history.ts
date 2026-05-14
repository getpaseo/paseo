import { useCallback, useMemo, useRef } from "react";
import { useGlobalPromptHistoryStore } from "@/stores/prompt-history-store";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { isCursorOnFirstLine, isCursorOnLastLine } from "@/utils/cursor-line-position";

const EMPTY_STREAM: readonly StreamItem[] = [];

export interface UsePromptHistoryArgs {
  /** Current value of the input. */
  value: string;
  /** Cursor position (collapsed selection). When start !== end, callers should
   * pass `selection.start` — selection mode is not treated as a recall trigger. */
  cursorIndex: number;
  /** Active agent — drives per-agent history priority. */
  agentId: string;
  /** Active server — drives per-agent history priority. */
  serverId: string;
  /** Called when the hook wants to replace the input with a different value. */
  onApply: (text: string) => void;
}

export interface UsePromptHistoryResult {
  /**
   * Key handler that follows the autocomplete contract: returns `true` when
   * the event was consumed (caller should NOT run default behavior), `false`
   * when the caller should let default behavior happen (e.g. cursor move).
   */
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean;
  /** Clears any in-progress history navigation. Call after submit / on blur. */
  reset: () => void;
}

interface NavigationState {
  /** 0 = newest history entry, 1 = second newest, etc. */
  index: number;
  /** What the input held when the user first pressed ArrowUp. Restored when
   * ArrowDown walks back past index 0. */
  draft: string;
  /** Snapshot of the merged entry list at navigation start. Frozen for the
   * duration of navigation so new incoming messages don't shift the index. */
  snapshot: string[];
  /** What we last set the input to. Used to detect that the user has typed
   * (drift), at which point we drop the draft and exit navigation. */
  appliedValue: string;
}

interface PromptHistoryRefState {
  entries: string[];
  value: string;
  cursorIndex: number;
  onApply: (text: string) => void;
}

function collectUserPrompts(items: readonly StreamItem[], out: string[], seen: Set<string>): void {
  for (const item of items) {
    if (item.kind !== "user_message") continue;
    const trimmed = item.text.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
}

/**
 * Returns the merged history list, oldest-first. Entries from the current
 * agent's session take priority (they appear at their natural recency); the
 * global cross-agent history fills in everything else, deduplicated.
 *
 * Internal export for unit tests.
 */
export function mergePromptHistorySources(input: {
  localTail: readonly StreamItem[];
  localHead: readonly StreamItem[];
  globalEntries: readonly string[];
}): string[] {
  const seen = new Set<string>();
  const localPrompts: string[] = [];
  // Tail came first chronologically, then Head. See session-context.tsx where
  // late chunks are appended to head while finished turns sit in tail.
  collectUserPrompts(input.localTail, localPrompts, seen);
  collectUserPrompts(input.localHead, localPrompts, seen);

  const supplemental: string[] = [];
  for (const entry of input.globalEntries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    supplemental.push(entry);
  }

  // Result ordering: oldest-first. Global supplemental comes first because
  // those are presumed to be from earlier (other) sessions; the local list is
  // the most recent stuff the user has been doing in this agent.
  return [...supplemental, ...localPrompts];
}

export function usePromptHistory(args: UsePromptHistoryArgs): UsePromptHistoryResult {
  const { value, cursorIndex, agentId, serverId, onApply } = args;

  const localTail = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamTail.get(agentId) ?? EMPTY_STREAM,
  );
  const localHead = useSessionStore(
    (state) => state.sessions[serverId]?.agentStreamHead.get(agentId) ?? EMPTY_STREAM,
  );
  const globalEntries = useGlobalPromptHistoryStore((state) => state.entries);

  const entries = useMemo(
    () => mergePromptHistorySources({ localTail, localHead, globalEntries }),
    [localTail, localHead, globalEntries],
  );

  // Render-time ref sync (same pattern composer.tsx already uses for autocomplete).
  // Lets us return a stable onKeyPress whose deps don't churn on every keystroke.
  const stateRef = useRef<PromptHistoryRefState>({ entries, value, cursorIndex, onApply });
  stateRef.current = { entries, value, cursorIndex, onApply };

  const navigationRef = useRef<NavigationState | null>(null);

  const reset = useCallback(() => {
    navigationRef.current = null;
  }, []);

  const onKeyPress = useCallback((event: { key: string; preventDefault: () => void }): boolean => {
    const {
      entries: live,
      value: liveValue,
      cursorIndex: liveCursor,
      onApply: liveApply,
    } = stateRef.current;

    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;

    // Drift detection: the user typed since we last set the value, so they
    // intentionally left the navigation. Drop the saved draft.
    if (navigationRef.current && navigationRef.current.appliedValue !== liveValue) {
      navigationRef.current = null;
    }

    if (event.key === "ArrowUp") {
      if (!isCursorOnFirstLine(liveValue, liveCursor)) return false;

      if (!navigationRef.current) {
        // Fresh navigation: snapshot live history, save current draft, fill latest.
        if (live.length === 0) return false;
        const latest = live[live.length - 1];
        if (latest === undefined) return false;
        navigationRef.current = {
          index: 0,
          draft: liveValue,
          snapshot: live.slice(),
          appliedValue: latest,
        };
        event.preventDefault();
        liveApply(latest);
        return true;
      }

      // Already navigating: walk one step further into the past.
      const { snapshot, index } = navigationRef.current;
      const oldestIndex = snapshot.length - 1;
      if (index >= oldestIndex) {
        // Already at the oldest entry. Swallow so cursor doesn't jump.
        event.preventDefault();
        return true;
      }
      const nextIndex = index + 1;
      const text = snapshot[snapshot.length - 1 - nextIndex];
      if (text === undefined) return false;
      navigationRef.current = {
        ...navigationRef.current,
        index: nextIndex,
        appliedValue: text,
      };
      event.preventDefault();
      liveApply(text);
      return true;
    }

    // ArrowDown: only meaningful while navigating.
    if (!navigationRef.current) return false;
    if (!isCursorOnLastLine(liveValue, liveCursor)) return false;

    const { snapshot, index, draft } = navigationRef.current;

    if (index === 0) {
      // Walk back to the live draft, exit navigation.
      navigationRef.current = null;
      event.preventDefault();
      liveApply(draft);
      return true;
    }

    const nextIndex = index - 1;
    const text = snapshot[snapshot.length - 1 - nextIndex];
    if (text === undefined) return false;
    navigationRef.current = {
      ...navigationRef.current,
      index: nextIndex,
      appliedValue: text,
    };
    event.preventDefault();
    liveApply(text);
    return true;
  }, []);

  return { onKeyPress, reset };
}
