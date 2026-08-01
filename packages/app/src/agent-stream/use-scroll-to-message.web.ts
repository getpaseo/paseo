import type React from "react";
import { useCallback } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

interface UseScrollToMessageInput {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  rowVirtualizer: Virtualizer<HTMLElement, Element>;
  historyVirtualized: readonly { id: string }[];
  cancelPendingStickToBottom: () => void;
  setFollowOutput: (value: boolean) => boolean;
  onNearBottomChange: (value: boolean) => void;
}

export function useScrollToMessage({
  scrollContainerRef,
  rowVirtualizer,
  historyVirtualized,
  cancelPendingStickToBottom,
  setFollowOutput,
  onNearBottomChange,
}: UseScrollToMessageInput) {
  return useCallback(
    (itemId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      cancelPendingStickToBottom();
      setFollowOutput(false);

      const mounted = container.querySelector<HTMLElement>(
        `[data-history-row-id="${CSS.escape(itemId)}"]`,
      );
      if (mounted) {
        mounted.scrollIntoView({ behavior: "smooth", block: "start" });
        onNearBottomChange(false);
        return;
      }

      const index = historyVirtualized.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        rowVirtualizer.scrollToIndex(index, { align: "start", behavior: "smooth" });
        onNearBottomChange(false);
      }
    },
    [
      cancelPendingStickToBottom,
      historyVirtualized,
      onNearBottomChange,
      rowVirtualizer,
      scrollContainerRef,
      setFollowOutput,
    ],
  );
}
