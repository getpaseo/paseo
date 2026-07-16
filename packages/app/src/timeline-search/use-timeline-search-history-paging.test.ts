// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useTimelineSearchHistoryPaging,
  type TimelineSearchHistoryPagingInput,
} from "./use-timeline-search-history-paging";

function baseInput(
  overrides: Partial<TimelineSearchHistoryPagingInput> = {},
): TimelineSearchHistoryPagingInput {
  return {
    isOpen: true,
    query: "hello",
    hasOlder: true,
    isLoadingOlder: false,
    itemCount: 10,
    loadOlder: vi.fn(),
    ...overrides,
  };
}

describe("useTimelineSearchHistoryPaging", () => {
  it("pages older history while the panel is open with a query and more remains", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() => useTimelineSearchHistoryPaging(baseInput({ loadOlder })));

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(result.current.isPaging).toBe(true);
    expect(result.current.historyLoadFailed).toBe(false);
  });

  it("does not page when the panel is closed", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging(baseInput({ isOpen: false, loadOlder })),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current.isPaging).toBe(false);
  });

  it("does not page for a blank query", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging(baseInput({ query: "   ", loadOlder })),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current.isPaging).toBe(false);
  });

  it("does not start a new page while one is already in flight", () => {
    const loadOlder = vi.fn();
    renderHook(() =>
      useTimelineSearchHistoryPaging(baseInput({ isLoadingOlder: true, loadOlder })),
    );

    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("stops paging and reports done once no older history remains", () => {
    const loadOlder = vi.fn();
    const { result } = renderHook(() =>
      useTimelineSearchHistoryPaging(baseInput({ hasOlder: false, loadOlder })),
    );

    expect(loadOlder).not.toHaveBeenCalled();
    expect(result.current.isPaging).toBe(false);
  });

  it("stops paging when loadOlder rejects", async () => {
    const loadOlder = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTimelineSearchHistoryPaging(baseInput({ loadOlder })));

    await waitFor(() => expect(result.current.historyLoadFailed).toBe(true));
    expect(result.current.isPaging).toBe(false);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("drives the next page after a load completes with progress, resetting the failure count", () => {
    const loadOlder = vi.fn();
    const { rerender } = renderHook(
      (props: { isLoadingOlder: boolean; itemCount: number }) =>
        useTimelineSearchHistoryPaging(baseInput({ ...props, loadOlder })),
      { initialProps: { isLoadingOlder: false, itemCount: 10 } },
    );

    expect(loadOlder).toHaveBeenCalledTimes(1);
    // Page goes in flight, then completes having grown the item list.
    rerender({ isLoadingOlder: true, itemCount: 10 });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender({ isLoadingOlder: false, itemCount: 110 });
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated fruitless loads and reports historyLoadFailed", () => {
    const loadOlder = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isLoadingOlder: boolean; itemCount: number }) =>
        useTimelineSearchHistoryPaging(baseInput({ ...props, loadOlder })),
      { initialProps: { isLoadingOlder: false, itemCount: 10 } },
    );

    // Three consecutive loads that complete WITHOUT growing the item list and
    // without clearing hasOlder — e.g. the daemon fetch keeps failing.
    for (let attempt = 0; attempt < 3; attempt++) {
      rerender({ isLoadingOlder: true, itemCount: 10 });
      rerender({ isLoadingOlder: false, itemCount: 10 });
    }

    expect(result.current.historyLoadFailed).toBe(true);
    expect(result.current.isPaging).toBe(false);
    const callsAfterStall = loadOlder.mock.calls.length;

    // Stalled: further renders must NOT retry (no infinite toast spam).
    rerender({ isLoadingOlder: false, itemCount: 10 });
    expect(loadOlder.mock.calls.length).toBe(callsAfterStall);
  });

  it("re-arms a stalled loop when the query changes", () => {
    const loadOlder = vi.fn();
    const { result, rerender } = renderHook(
      (props: { query: string; isLoadingOlder: boolean; itemCount: number }) =>
        useTimelineSearchHistoryPaging(baseInput({ ...props, loadOlder })),
      { initialProps: { query: "hello", isLoadingOlder: false, itemCount: 10 } },
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      rerender({ query: "hello", isLoadingOlder: true, itemCount: 10 });
      rerender({ query: "hello", isLoadingOlder: false, itemCount: 10 });
    }
    expect(result.current.historyLoadFailed).toBe(true);

    rerender({ query: "world", isLoadingOlder: false, itemCount: 10 });
    expect(result.current.historyLoadFailed).toBe(false);
    expect(result.current.isPaging).toBe(true);
  });
});
