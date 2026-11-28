import React, { useCallback, useLayoutEffect, useState, type RefObject } from "react";
import { OverlayScrollbar, type OverlayScrollbarMetrics } from "./overlay-scrollbar";

export function DomOverlayScrollbar({
  scrollContainerRef,
  onUserScrollUp,
  autoHide = false,
}: {
  scrollContainerRef: RefObject<HTMLElement | null>;
  onUserScrollUp: () => void;
  autoHide?: boolean;
}) {
  const [isScrolling, setIsScrolling] = useState(false);
  const [metrics, setMetrics] = useState<OverlayScrollbarMetrics>({
    offset: 0,
    viewportSize: 0,
    contentSize: 0,
  });
  const syncMetrics = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    setMetrics({
      offset: Math.max(0, scrollContainer.scrollTop),
      viewportSize: Math.max(0, scrollContainer.clientHeight),
      contentSize: Math.max(0, scrollContainer.scrollHeight),
    });
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    syncMetrics();
    let hideTimeout: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      syncMetrics();
      if (!autoHide) return;
      setIsScrolling(true);
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => setIsScrolling(false), 800);
    };
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(syncMetrics);
    observer.observe(scrollContainer);
    const content = scrollContainer.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      scrollContainer.removeEventListener("scroll", onScroll);
      clearTimeout(hideTimeout);
      observer.disconnect();
    };
  }, [autoHide, scrollContainerRef, syncMetrics]);

  const scrollToOffset = useCallback(
    (offset: number) => {
      const scrollContainer = scrollContainerRef.current;
      if (scrollContainer) scrollContainer.scrollTop = offset;
    },
    [scrollContainerRef],
  );

  return (
    <OverlayScrollbar
      metrics={metrics}
      onScrollToOffset={scrollToOffset}
      onUserScrollUp={onUserScrollUp}
      visible={!autoHide || isScrolling}
    />
  );
}
