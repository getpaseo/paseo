// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTimelineSearchHistoryPaging } from "./use-timeline-search-history-paging";

describe("useTimelineSearchHistoryPaging", () => {
  it("pages older history while the panel is open with a query and more remains", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging({
        isOpen: true,
        query: "hello",
        hasOlder: true,
        isLoadingOlder: false,
        loadOlder,
      }),
    );

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true); // still paging
  });

  it("does not page when the panel is closed", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging({
        isOpen: false,
        query: "hello",
        hasOlder: true,
        isLoadingOlder: false,
        loadOlder,
      }),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it("does not page for a blank query", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging({
        isOpen: true,
        query: "   ",
        hasOlder: true,
        isLoadingOlder: false,
        loadOlder,
      }),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it("does not start a new page while one is already in flight", () => {
    const loadOlder = vi.fn();
    renderHook(() =>
      useTimelineSearchHistoryPaging({
        isOpen: true,
        query: "hello",
        hasOlder: true,
        isLoadingOlder: true,
        loadOlder,
      }),
    );

    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("stops paging and reports done once no older history remains", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging({
        isOpen: true,
        query: "hello",
        hasOlder: false,
        isLoadingOlder: false,
        loadOlder,
      }),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current).toBe(false); // fully loaded -> not paging
  });

  it("drives the next page after an in-flight load completes and more remains", () => {
    const loadOlder = vi.fn();
    const { rerender } = renderHook(
      (props: { isLoadingOlder: boolean }) =>
        useTimelineSearchHistoryPaging({
          isOpen: true,
          query: "hello",
          hasOlder: true,
          isLoadingOlder: props.isLoadingOlder,
          loadOlder,
        }),
      { initialProps: { isLoadingOlder: false } },
    );

    // First render (not loading) fires one page; that page goes in flight, then
    // completes with more still remaining, which drives the next page.
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender({ isLoadingOlder: true });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender({ isLoadingOlder: false });
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });
});
