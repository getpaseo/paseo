import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";

/**
 * Up/down arrow recall of previously sent messages, sourced from the agent's
 * daemon-backed message stream (the same user messages rendered above the
 * composer), presented as a completion-style popover (the same
 * AutocompletePopover used by file and skill pickers).
 *
 * Interaction mirrors @file / /skill completion: ArrowUp on an empty input
 * opens the popover with the most recent message highlighted (closest to the
 * input); ArrowUp/Down move the highlight (Up = older); Enter or a click fills
 * the input and closes; Escape closes without filling.
 */

const MAX_HISTORY = 100;
const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];

/**
 * Pure: extract recallable user-message texts (oldest-first) from an agent's
 * stream tail, capped to the most recent MAX_HISTORY. Empty/whitespace-only
 * messages are ignored.
 */
export function deriveMessageHistory(
  items: readonly StreamItem[],
  max: number = MAX_HISTORY,
): string[] {
  const texts: string[] = [];
  for (const item of items) {
    if (item.kind === "user_message") {
      const text = item.text.trim();
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts.length > max ? texts.slice(texts.length - max) : texts;
}

export interface UseMessageHistoryArgs {
  agentId: string;
  serverId: string;
  value: string;
  setValue: (text: string) => void;
  cursorIndex: number;
}

export interface MessageHistoryPopover {
  visible: boolean;
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
}

export interface UseMessageHistoryResult {
  /** Key handler; returns true when it consumed a key (arrow / enter / escape). */
  handleHistoryKey: (event: { key: string; preventDefault: () => void }) => boolean;
  /** Close the popover without selecting (e.g. on input blur). */
  closePopover: () => void;
  /** Reactive view driving the history AutocompletePopover. */
  popover: MessageHistoryPopover;
}

export function useMessageHistory({
  agentId,
  serverId,
  value,
  setValue,
  cursorIndex,
}: UseMessageHistoryArgs): UseMessageHistoryResult {
  // The authoritative source: the agent's chronological stream tail from the
  // daemon. Empty for placeholder agentIds used by agent-creation composers.
  const streamItems =
    useSessionStore((state) =>
      agentId && serverId ? state.sessions[serverId]?.agentStreamTail?.get(agentId) : undefined,
    ) ?? EMPTY_STREAM_ITEMS;
  const history = useMemo(() => deriveMessageHistory(streamItems), [streamItems]);

  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Mirror live values into refs so the stable key handler reads fresh state
  // without churn in callback identity (matches the autocomplete ref pattern).
  const openRef = useRef(false);
  openRef.current = open;
  const selectedIndexRef = useRef(0);
  selectedIndexRef.current = selectedIndex;
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorIndexRef = useRef(cursorIndex);
  cursorIndexRef.current = cursorIndex;
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  // Close the popover and drop a stale selection when the scoped conversation
  // changes or the stream shrinks below the current index.
  useEffect(() => {
    setOpen(false);
  }, [agentId, serverId]);

  useEffect(() => {
    setSelectedIndex((index) => (history.length === 0 ? 0 : Math.min(index, history.length - 1)));
  }, [history]);

  const closePopover = useCallback(() => setOpen(false), []);

  const handleHistoryKey = useCallback(
    (event: { key: string; preventDefault: () => void }) => {
      if (history.length === 0) {
        return false;
      }
      if (!openRef.current) {
        // Open with ArrowUp only when the input is empty and the cursor sits
        // at the start, so multi-line line navigation still works otherwise.
        if (event.key === "ArrowUp" && valueRef.current === "" && cursorIndexRef.current === 0) {
          event.preventDefault();
          setSelectedIndex(history.length - 1);
          setOpen(true);
          return true;
        }
        return false;
      }

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((index) => Math.max(0, index - 1));
          return true;
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((index) => Math.min(history.length - 1, index + 1));
          return true;
        case "Enter":
          event.preventDefault();
          setOpen(false);
          setValueRef.current(history[selectedIndexRef.current] ?? "");
          return true;
        case "Escape":
          event.preventDefault();
          setOpen(false);
          return true;
        default:
          // Any other key (typing) closes the popover and falls through to the input.
          setOpen(false);
          return false;
      }
    },
    [history],
  );

  const onSelect = useCallback((option: AutocompleteOption) => {
    setOpen(false);
    setValueRef.current(option.label);
  }, []);

  const options = useMemo<AutocompleteOption[]>(
    () =>
      history.map((text, index) => ({
        id: `${agentId}:${index}`,
        label: text,
        kind: "history",
      })),
    [agentId, history],
  );

  const popover: MessageHistoryPopover = { visible: open, options, selectedIndex, onSelect };

  return { handleHistoryKey, closePopover, popover };
}
