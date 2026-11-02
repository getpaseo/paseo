import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ImportSessionListProps } from "./import-session-list.types";

const SCROLLER_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
  overscrollBehavior: "contain",
};
const CONTENT_STYLE: CSSProperties = { width: "100%", position: "relative" };

export function ImportSessionList<Item>({
  data,
  keyExtractor,
  renderItem,
  header,
  footer,
}: ImportSessionListProps<Item>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const indexByKey = useMemo(
    () => new Map(data.map((item, index) => [keyExtractor(item), index])),
    [data, keyExtractor],
  );
  const focusedIndex = focusedKey === null ? undefined : indexByKey.get(focusedKey);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const visible = defaultRangeExtractor(range);
      if (focusedIndex === undefined) return visible;
      // Keep focus and its Tab neighbours mounted when PageDown/End moves the window.
      const focused = [focusedIndex - 1, focusedIndex, focusedIndex + 1].filter(
        (index) => index >= 0 && index < data.length,
      );
      return [...new Set([...visible, ...focused])].sort((left, right) => left - right);
    },
    [data.length, focusedIndex],
  );
  const handleFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const row = event.target.closest<HTMLElement>("[data-session-key]");
    setFocusedKey(row?.dataset.sessionKey ?? null);
  }, []);
  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
  }, []);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderHeight(event.nativeEvent.layout.height);
  }, []);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const getItemKey = useCallback(
    (index: number) => keyExtractor(data[index]!),
    [data, keyExtractor],
  );
  const estimateSize = useCallback(() => 88, []);
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement,
    getItemKey,
    estimateSize,
    scrollMargin: headerHeight,
    overscan: 5,
    rangeExtractor,
  });
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        !(target instanceof HTMLElement) ||
        !event.currentTarget.contains(target) ||
        target.isContentEditable ||
        target.closest("input, textarea, select")
      )
        return;
      if (event.key === "End") {
        event.preventDefault();
        // Reconcile the landing position as variable-height rows are measured.
        virtualizer.scrollToIndex(data.length - 1, { align: "end" });
      } else if (event.key === "Home") {
        event.preventDefault();
        virtualizer.scrollToOffset(0);
      } else if (event.key === "PageDown" || event.key === "PageUp") {
        event.preventDefault();
        // Native page-scroll animations can keep moving after Home or End.
        const direction = event.key === "PageDown" ? 1 : -1;
        virtualizer.scrollBy(direction * event.currentTarget.clientHeight);
      }
    },
    [data.length, virtualizer],
  );
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const contentStyle = useMemo(() => ({ ...CONTENT_STYLE, height: totalSize }), [totalSize]);
  const rowStyle = useCallback(
    (offset: number): CSSProperties => ({
      ...CONTENT_STYLE,
      position: "absolute",
      top: 0,
      transform: `translateY(${offset}px)`,
    }),
    [],
  );

  return (
    <div
      ref={scrollRef}
      style={SCROLLER_STYLE}
      data-testid="import-session-list"
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      onKeyDown={handleKeyDown}
    >
      <View onLayout={handleHeaderLayout}>{header}</View>
      <div style={contentStyle}>
        {virtualRows.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            data-session-key={row.key}
            ref={virtualizer.measureElement}
            style={rowStyle(row.start - headerHeight)}
          >
            {renderItem(data[row.index]!)}
          </div>
        ))}
      </div>
      <div>{footer}</div>
    </div>
  );
}
