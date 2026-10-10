/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from "react-native";
import type { RefObject } from "react";
import { describe, expect, it, vi } from "vitest";

import { getScrollOffsetToRevealItem, useRevealActiveItem } from "./scroll-reveal";

function layoutEvent(top: number, height: number): LayoutChangeEvent {
  return {
    nativeEvent: { layout: { x: 0, y: top, width: 600, height } },
  } as LayoutChangeEvent;
}

function scrollEvent(offset: number): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 600, height: 1000 },
      layoutMeasurement: { width: 600, height: 200 },
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

function stubScrollView() {
  const scrollTo = vi.fn();
  const scrollRef = { current: { scrollTo } } as unknown as RefObject<ScrollView | null>;
  return { scrollRef, scrollTo };
}

function measureRows(
  handlers: ReturnType<typeof useRevealActiveItem>,
  rows: { top: number; height: number }[],
): void {
  rows.forEach((row, index) => handlers.onItemLayout(index, layoutEvent(row.top, row.height)));
}

function evenlySpacedRows(count: number, height = 50): { top: number; height: number }[] {
  return Array.from({ length: count }, (_, index) => ({ top: index * height, height }));
}

describe("getScrollOffsetToRevealItem", () => {
  it("keeps the offset when the item is already inside the viewport", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 40,
        viewportHeight: 200,
        itemTop: 100,
        itemHeight: 40,
      }),
    ).toBe(40);
  });

  it("scrolls up to the item top when the item is above the viewport", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 300,
        viewportHeight: 200,
        itemTop: 240,
        itemHeight: 40,
      }),
    ).toBe(240);
  });

  it("scrolls down just far enough to reveal the item bottom", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 0,
        viewportHeight: 200,
        itemTop: 380,
        itemHeight: 40,
      }),
    ).toBe(220);
  });

  it("stays put before the viewport has been measured", () => {
    expect(
      getScrollOffsetToRevealItem({
        currentOffset: 120,
        viewportHeight: 0,
        itemTop: 400,
        itemHeight: 40,
      }),
    ).toBe(120);
  });
});

describe("useRevealActiveItem", () => {
  it("scrolls the selected row into view once it moves past the viewport bottom", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ activeIndex }) => useRevealActiveItem({ activeIndex, listKey: "rows", scrollRef }),
      { initialProps: { activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      measureRows(result.current, evenlySpacedRows(10));
    });
    act(() => result.current.onScroll(scrollEvent(0)));
    scrollTo.mockClear();

    rerender({ activeIndex: 8 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 250, animated: false });
  });

  it("scrolls back up when the selection wraps to a row above the viewport", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ activeIndex }) => useRevealActiveItem({ activeIndex, listKey: "rows", scrollRef }),
      { initialProps: { activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      measureRows(result.current, [
        { top: 0, height: 50 },
        { top: 50, height: 50 },
      ]);
    });
    act(() => result.current.onScroll(scrollEvent(300)));
    scrollTo.mockClear();

    rerender({ activeIndex: 1 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 50, animated: false });
  });

  it("does not scroll for a selection that stays inside the viewport", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ activeIndex }) => useRevealActiveItem({ activeIndex, listKey: "rows", scrollRef }),
      { initialProps: { activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 400));
      measureRows(result.current, [
        { top: 0, height: 50 },
        { top: 50, height: 50 },
        { top: 100, height: 50 },
      ]);
    });
    scrollTo.mockClear();

    rerender({ activeIndex: 2 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("returns to the top when the rendered rows are replaced", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ listKey }) => useRevealActiveItem({ activeIndex: 0, listKey, scrollRef }),
      { initialProps: { listKey: "rows" } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      result.current.onItemLayout(0, layoutEvent(0, 50));
    });
    act(() => result.current.onScroll(scrollEvent(400)));
    scrollTo.mockClear();

    rerender({ listKey: "other-rows" });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
  });

  it("drops row measurements belonging to the replaced rows", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ listKey, activeIndex }) => useRevealActiveItem({ activeIndex, listKey, scrollRef }),
      { initialProps: { listKey: "rows", activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      result.current.onItemLayout(1, layoutEvent(900, 50));
    });
    rerender({ listKey: "other-rows", activeIndex: 1 });
    act(() => result.current.onScroll(scrollEvent(0)));
    scrollTo.mockClear();

    act(() => result.current.onItemLayout(1, layoutEvent(0, 50)));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not scroll on mount before anything is measured", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    renderHook(() => useRevealActiveItem({ activeIndex: 0, listKey: "rows", scrollRef }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reveals a variable-height row just far enough", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ activeIndex }) => useRevealActiveItem({ activeIndex, listKey: "rows", scrollRef }),
      { initialProps: { activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 100));
      measureRows(result.current, [
        { top: 0, height: 30 },
        { top: 30, height: 80 },
        { top: 110, height: 40 },
      ]);
    });
    scrollTo.mockClear();

    rerender({ activeIndex: 2 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 50, animated: false });
  });

  it("stays put when the selection points past the measured rows", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ activeIndex }) => useRevealActiveItem({ activeIndex, listKey: "rows", scrollRef }),
      { initialProps: { activeIndex: 0 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      measureRows(result.current, [
        { top: 0, height: 50 },
        { top: 50, height: 50 },
      ]);
    });
    scrollTo.mockClear();

    rerender({ activeIndex: 99 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does not detour through the top when rows are replaced mid-navigation", () => {
    const { scrollRef, scrollTo } = stubScrollView();
    const { result, rerender } = renderHook(
      ({ listKey, activeIndex }) => useRevealActiveItem({ activeIndex, listKey, scrollRef }),
      { initialProps: { listKey: "rows", activeIndex: 5 } },
    );

    act(() => {
      result.current.onViewportLayout(layoutEvent(0, 200));
      measureRows(result.current, evenlySpacedRows(10));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 100, animated: false });
    act(() => result.current.onScroll(scrollEvent(100)));
    scrollTo.mockClear();

    rerender({ listKey: "other-rows", activeIndex: 5 });
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      measureRows(result.current, evenlySpacedRows(10, 80));
    });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 280, animated: false });
    expect(scrollTo).not.toHaveBeenCalledWith({ y: 0, animated: false });
  });
});
