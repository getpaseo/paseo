import { useCallback, useEffect, useRef, type RefObject } from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
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

interface ItemLayout {
  top: number;
  height: number;
}

export interface RevealActiveItemHandlers {
  onItemLayout: (index: number, event: LayoutChangeEvent) => void;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

/**
 * Keeps the keyboard-selected row of a top-anchored ScrollView inside the
 * viewport. Rows are measured through onLayout because their height varies
 * with their content.
 *
 * `listKey` identifies the rendered rows. When it changes the list was
 * replaced: stale measurements are dropped and, when the selection restarts
 * at the top (`activeIndex === 0`, e.g. a new query), the viewport returns to
 * the top. A preserved selection (`activeIndex !== 0`, e.g. async results
 * arriving mid-navigation) keeps its scroll position and is revealed once the
 * new rows are measured, without a detour through the top.
 *
 * Bottom-anchored lists need different reset semantics (the composer
 * autocomplete pins to the end), so they share only getScrollOffsetToRevealItem.
 */
export function useRevealActiveItem(options: {
  activeIndex: number;
  listKey: string;
  scrollRef: RefObject<ScrollView | null>;
}): RevealActiveItemHandlers {
  const { activeIndex, listKey, scrollRef } = options;
  const itemLayoutsRef = useRef<Map<number, ItemLayout>>(new Map());
  const viewportHeightRef = useRef(0);
  const offsetRef = useRef(0);

  const reveal = useCallback(() => {
    const layout = itemLayoutsRef.current.get(activeIndex);
    if (!layout) {
      return;
    }
    const nextOffset = getScrollOffsetToRevealItem({
      currentOffset: offsetRef.current,
      viewportHeight: viewportHeightRef.current,
      itemTop: layout.top,
      itemHeight: layout.height,
    });
    if (Math.abs(nextOffset - offsetRef.current) < 1) {
      return;
    }
    offsetRef.current = nextOffset;
    scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
  }, [activeIndex, scrollRef]);

  const prevListKeyRef = useRef(listKey);
  useEffect(() => {
    if (prevListKeyRef.current === listKey) {
      return;
    }
    prevListKeyRef.current = listKey;
    itemLayoutsRef.current = new Map();
    if (activeIndex === 0) {
      offsetRef.current = 0;
      scrollRef.current?.scrollTo({ y: 0, animated: false });
    }
  }, [activeIndex, listKey, scrollRef]);

  useEffect(() => {
    reveal();
  }, [listKey, reveal]);

  const onItemLayout = useCallback(
    (index: number, event: LayoutChangeEvent) => {
      itemLayoutsRef.current.set(index, {
        top: event.nativeEvent.layout.y,
        height: event.nativeEvent.layout.height,
      });
      reveal();
    },
    [reveal],
  );

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

  return { onItemLayout, onViewportLayout, onScroll };
}
