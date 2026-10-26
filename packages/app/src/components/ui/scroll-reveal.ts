import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  View,
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
 * Bottom-anchored lists share only getScrollOffsetToRevealItem.
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
