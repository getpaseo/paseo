import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { createPromptJumpSettleController, PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";

interface UseScrollToMessageInput {
  active: boolean;
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
  active,
  scrollContainerRef,
  rowVirtualizer,
  historyVirtualized,
  cancelPendingStickToBottom,
  setFollowOutput,
  onNearBottomChange,
}: UseScrollToMessageInput) {
  const occurrenceRef = useRef<
    { signal: AbortSignal; targetTop(row: HTMLElement): number | null } | undefined
  >(undefined);
  const removeAbortListener = useRef<(() => void) | null>(null);
  const settleController = useMemo(
    () =>
      createPromptJumpSettleController({
        viewport: {
          findTargetTop(itemId) {
            const container = scrollContainerRef.current;
            const target = container?.querySelector<HTMLElement>(
              `[data-history-row-id="${CSS.escape(itemId)}"]`,
            );
            const occurrence = occurrenceRef.current;
            if (occurrence?.signal.aborted) return null;
            if (!target) return null;
            if (occurrence) return occurrence.targetTop(target);
            return target.getBoundingClientRect().top;
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

  useEffect(
    () => () => {
      removeAbortListener.current?.();
      settleController.cancel();
    },
    [settleController],
  );
  useLayoutEffect(() => {
    if (!active) {
      settleController.cancel();
    }
  }, [active, settleController]);

  const scrollToMessage = useCallback(
    (
      itemId: string,
      occurrence?: { signal: AbortSignal; targetTop(row: HTMLElement): number | null },
    ) => {
      occurrenceRef.current = occurrence;
      removeAbortListener.current?.();
      const cancel = () => settleController.cancel();
      occurrence?.signal.addEventListener("abort", cancel, { once: true });
      removeAbortListener.current = () => occurrence?.signal.removeEventListener("abort", cancel);
      if (!active) return;
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
      active,
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
