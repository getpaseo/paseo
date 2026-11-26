import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  View,
  ViewToken,
} from "react-native";

export function getScrollOffsetToRevealItem(args: {
  currentOffset: number;
  viewportHeight: number;
  itemTop: number;
  itemHeight: number;
}): number {
  if (args.viewportHeight <= 0) {
    return args.currentOffset;
  }

  const itemBottom = args.itemTop + args.itemHeight;
  const viewportTop = args.currentOffset;
  const viewportBottom = args.currentOffset + args.viewportHeight;

  if (args.itemTop < viewportTop) {
    return Math.max(0, args.itemTop);
  }

  if (itemBottom > viewportBottom) {
    return Math.max(0, itemBottom - args.viewportHeight);
  }

  return args.currentOffset;
}

export interface RevealActiveItemHandlers {
  activeItemRef: RefObject<View | null>;
  contentRef: RefObject<View | null>;
  onItemLayout: () => void;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/**
 * Reveals the keyboard-selected row using its current position in the scroll
 * content. Measuring on selection/list changes also covers retained rows that
 * move or keep their size without emitting another onLayout event on web.
 * A list replacement resets to the top only when selection restarts there.
 */
export function useRevealActiveItem(options: {
  activeIndex: number;
  listKey: string;
  scrollRef: RefObject<ScrollView | null>;
}): RevealActiveItemHandlers {
  const { activeIndex, listKey, scrollRef } = options;
  const activeItemRef = useRef<View | null>(null);
  const contentRef = useRef<View | null>(null);
  const viewportHeightRef = useRef(0);
  const offsetRef = useRef(0);
  const measurementRef = useRef(0);

  const reveal = useCallback(() => {
    const request = ++measurementRef.current;
    const item = activeItemRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!item || !scroll || !content) return;

    item.measureLayout(content, (_left, top, _width, height) => {
      if (request !== measurementRef.current || activeItemRef.current !== item) return;
      const nextOffset = getScrollOffsetToRevealItem({
        currentOffset: offsetRef.current,
        viewportHeight: viewportHeightRef.current,
        itemTop: top,
        itemHeight: height,
      });
      if (Math.abs(nextOffset - offsetRef.current) < 1) return;
      offsetRef.current = nextOffset;
      scroll.scrollTo({ y: nextOffset, animated: false });
    });
  }, [scrollRef]);

  const prevListKeyRef = useRef(listKey);
  useLayoutEffect(() => {
    if (prevListKeyRef.current !== listKey && activeIndex === 0) {
      offsetRef.current = 0;
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
    prevListKeyRef.current = listKey;
    reveal();
    return () => {
      // Measurements are asynchronous; a previous selection must not scroll us.
      measurementRef.current += 1;
    };
  }, [activeIndex, listKey, reveal, scrollRef]);

  const onViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      reveal();
    },
    [reveal],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  return { activeItemRef, contentRef, onItemLayout: reveal, onViewportLayout, onScroll };
}

export const FULLY_VISIBLE_VIEWABILITY = { itemVisiblePercentThreshold: 100 };

export interface RevealActiveFlatListHandlers<T> {
  viewabilityConfig: typeof FULLY_VISIBLE_VIEWABILITY;
  onViewableItemsChanged: (info: { viewableItems: ViewToken<T>[] }) => void;
  onScrollToIndexFailed: (info: { index: number; averageItemLength: number }) => void;
  onContentSizeChange: () => void;
  onLayout: () => void;
}

interface VisibleRange {
  first: number;
  last: number;
}

function nextVisibleRangeAfterReveal(
  visible: VisibleRange | null,
  row: number,
  isNearer: boolean,
): VisibleRange | null {
  if (!visible) return null;
  const span = visible.last - visible.first;
  return isNearer ? { first: row, last: row + span } : { first: row - span, last: row };
}

/**
 * Keeps the keyboard-active row visible inside a virtualized FlatList. Tracks
 * fully visible rows via viewability callbacks, retries unmeasured rows as they
 * mount after scrollToIndexFailed, and supports scrolling to offset 0 when a
 * header item above row 0 is active.
 */
export function useRevealActiveFlatListRow<T>({
  listRef,
  itemCount,
  activeIndex,
  hasHeader = false,
  waitForViewable = false,
  listKey,
}: {
  listRef: RefObject<FlatList<T> | null>;
  itemCount: number;
  activeIndex: number | "top" | null;
  hasHeader?: boolean;
  waitForViewable?: boolean;
  listKey?: unknown;
}): RevealActiveFlatListHandlers<T> {
  const fullyVisibleRows = useRef<VisibleRange | null>(null);
  const pendingReveal = useRef<number | null>(null);
  const isPendingRowMeasured = useRef(true);
  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;
  const hasHeaderRef = useRef(hasHeader);
  hasHeaderRef.current = hasHeader;
  const waitForViewableRef = useRef(waitForViewable);
  waitForViewableRef.current = waitForViewable;

  const revealPendingRow = useCallback(() => {
    const list = listRef.current;
    const row = pendingReveal.current;
    if (!list || row === null || row < 0 || row >= itemCountRef.current) return;

    const visible = fullyVisibleRows.current;
    if (waitForViewableRef.current && !visible) return;
    if (visible && row >= visible.first && row <= visible.last) {
      pendingReveal.current = null;
      return;
    }

    if (row === 0 && !hasHeaderRef.current) {
      list.scrollToOffset({ offset: 0, animated: false });
      pendingReveal.current = null;
      fullyVisibleRows.current = nextVisibleRangeAfterReveal(visible, 0, true);
      return;
    }

    const isNearer = visible !== null && row < visible.first;
    let viewPosition = 0.5;
    if (visible !== null) {
      viewPosition = isNearer ? 0 : 1;
    }
    isPendingRowMeasured.current = true;
    list.scrollToIndex({ index: row, viewPosition, animated: false });
    if (!isPendingRowMeasured.current) return;
    pendingReveal.current = null;
    fullyVisibleRows.current = nextVisibleRangeAfterReveal(visible, row, isNearer);
  }, [listRef]);

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      isPendingRowMeasured.current = false;
      if (info.index >= itemCountRef.current - 1) {
        listRef.current?.scrollToEnd({ animated: false });
        return;
      }
      listRef.current?.scrollToOffset({
        offset: info.index * info.averageItemLength,
        animated: false,
      });
    },
    [listRef],
  );

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<T>[] }) => {
      const indexes = viewableItems.flatMap((token) => (token.index === null ? [] : [token.index]));
      if (indexes.length === 0) return;
      fullyVisibleRows.current = { first: Math.min(...indexes), last: Math.max(...indexes) };
      revealPendingRow();
    },
    [revealPendingRow],
  );

  useEffect(() => {
    if (activeIndex === "top") {
      pendingReveal.current = null;
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    pendingReveal.current = activeIndex !== null && activeIndex >= 0 ? activeIndex : null;
    revealPendingRow();
  }, [activeIndex, listKey, listRef, revealPendingRow]);

  // A viewport that got shorter can leave the selected row outside it.
  const handleLayout = useCallback(() => {
    listRef.current?.recordInteraction();
    pendingReveal.current =
      typeof activeIndex === "number" && activeIndex >= 0 ? activeIndex : null;
    revealPendingRow();
  }, [activeIndex, listRef, revealPendingRow]);

  return {
    viewabilityConfig: FULLY_VISIBLE_VIEWABILITY,
    onViewableItemsChanged: handleViewableItemsChanged,
    onScrollToIndexFailed: handleScrollToIndexFailed,
    onContentSizeChange: revealPendingRow,
    onLayout: handleLayout,
  };
}
