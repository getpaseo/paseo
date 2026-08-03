import type React from "react";
import { useCallback, useEffect, useMemo } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { createPromptJumpSettleController, PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";

interface UseScrollToMessageInput {
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  rowVirtualizer: Virtualizer<HTMLElement, Element>;
  historyVirtualized: readonly { id: string }[];
  cancelPendingStickToBottom: () => void;
  setFollowOutput: (value: boolean) => boolean;
  onNearBottomChange: (value: boolean) => void;
}

const SCROLL_AFFECTING_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

export function useScrollToMessage({
  scrollContainerRef,
  rowVirtualizer,
  historyVirtualized,
  cancelPendingStickToBottom,
  setFollowOutput,
  onNearBottomChange,
}: UseScrollToMessageInput) {
  const settleController = useMemo(
    () =>
      createPromptJumpSettleController({
        viewport: {
          findTargetTop(itemId) {
            const container = scrollContainerRef.current;
            const target = container?.querySelector<HTMLElement>(
              `[data-history-row-id="${CSS.escape(itemId)}"]`,
            );
            return target?.getBoundingClientRect().top ?? null;
          },
          getContainerTop() {
            return scrollContainerRef.current?.getBoundingClientRect().top ?? 0;
          },
          getScrollMetrics() {
            const container = scrollContainerRef.current;
            return {
              clientHeight: container?.clientHeight ?? 0,
              scrollHeight: container?.scrollHeight ?? 0,
              scrollTop: container?.scrollTop ?? 0,
            };
          },
          setScrollTop(scrollTop) {
            const container = scrollContainerRef.current;
            if (container) container.scrollTop = scrollTop;
          },
          subscribeToUserIntent(listener) {
            const container = scrollContainerRef.current;
            if (!container) return () => undefined;
            const handleKeyDown = (event: KeyboardEvent) => {
              if (SCROLL_AFFECTING_KEYS.has(event.key)) listener();
            };
            container.addEventListener("wheel", listener, { passive: true });
            container.addEventListener("touchstart", listener, { passive: true });
            container.addEventListener("keydown", handleKeyDown, { passive: true });
            return () => {
              container.removeEventListener("wheel", listener);
              container.removeEventListener("touchstart", listener);
              container.removeEventListener("keydown", handleKeyDown);
            };
          },
        },
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
      }),
    [scrollContainerRef],
  );

  useEffect(() => () => settleController.cancel(), [settleController]);

  const scrollToMessage = useCallback(
    (itemId: string) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      cancelPendingStickToBottom();
      setFollowOutput(false);

      const mounted = container.querySelector<HTMLElement>(
        `[data-history-row-id="${CSS.escape(itemId)}"]`,
      );
      if (mounted) {
        const delta =
          mounted.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          PROMPT_JUMP_TOP_INSET_PX;
        container.scrollTop += delta;
        settleController.start(itemId);
        onNearBottomChange(false);
        return;
      }

      const index = historyVirtualized.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        rowVirtualizer.scrollToIndex(index, { align: "start" });
        settleController.start(itemId);
        onNearBottomChange(false);
      }
    },
    [
      cancelPendingStickToBottom,
      historyVirtualized,
      onNearBottomChange,
      rowVirtualizer,
      scrollContainerRef,
      settleController,
      setFollowOutput,
    ],
  );

  return {
    isJumpSettling: settleController.isActive,
    scrollToMessage,
  };
}
