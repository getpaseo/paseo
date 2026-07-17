// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import type { TimelineSearchMatch } from "./timeline-search-model";
import { useTimelineSearchScroll } from "./use-timeline-search-scroll";

function makeMatch(id: string): TimelineSearchMatch {
  const item: StreamItem = {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date("2024-01-01"),
  };
  return {
    item,
    field: "text",
    fieldOffset: 0,
    snippet: id,
    snippetMatchOffset: 0,
    snippetMatchLength: id.length,
    matchOffset: 0,
    matchLength: id.length,
    occurrenceIndex: 0,
  };
}

function makeViewportHandle(): StreamViewportHandle {
  return {
    scrollToBottom: vi.fn(),
    prepareForViewportChange: vi.fn(),
    scrollToItem: vi.fn().mockReturnValue(true),
    scrollBy: vi.fn(),
    getWindowCenterY: vi.fn().mockReturnValue(400),
  };
}

// Runs the frame callback synchronously so assertions don't need to wait on
// real requestAnimationFrame timing.
const syncRequestFrame = (callback: () => void) => {
  callback();
  return 0;
};
const noopCancelFrame = () => {};

describe("useTimelineSearchScroll", () => {
  it("does nothing when the panel is closed", () => {
    const viewportRef = { current: makeViewportHandle() };
    renderHook(() =>
      useTimelineSearchScroll({
        isOpen: false,
        matches: [makeMatch("a")],
        selectedIndex: 0,
        navigationRevision: 1,
        isLiveHeadItem: () => false,
        findGroupIdForItem: () => null,
        isGroupExpanded: () => false,
        expandGroup: vi.fn(),
        viewportRef,
        requestFrame: syncRequestFrame,
        cancelFrame: noopCancelFrame,
      }),
    );
    expect(viewportRef.current.scrollToBottom).not.toHaveBeenCalled();
    expect(viewportRef.current.scrollToItem).not.toHaveBeenCalled();
  });

  it("does nothing when there is no selected match", () => {
    const viewportRef = { current: makeViewportHandle() };
    renderHook(() =>
      useTimelineSearchScroll({
        isOpen: true,
        matches: [],
        selectedIndex: -1,
        navigationRevision: 1,
        isLiveHeadItem: () => false,
        findGroupIdForItem: () => null,
        isGroupExpanded: () => false,
        expandGroup: vi.fn(),
        viewportRef,
        requestFrame: syncRequestFrame,
        cancelFrame: noopCancelFrame,
      }),
    );
    expect(viewportRef.current.scrollToBottom).not.toHaveBeenCalled();
    expect(viewportRef.current.scrollToItem).not.toHaveBeenCalled();
  });

  it("scrolls to bottom for a live-head match instead of calling scrollToItem", () => {
    const viewportRef = { current: makeViewportHandle() };
    renderHook(() =>
      useTimelineSearchScroll({
        isOpen: true,
        matches: [makeMatch("live-1")],
        selectedIndex: 0,
        navigationRevision: 1,
        isLiveHeadItem: (id) => id === "live-1",
        findGroupIdForItem: () => null,
        isGroupExpanded: () => false,
        expandGroup: vi.fn(),
        viewportRef,
        requestFrame: syncRequestFrame,
        cancelFrame: noopCancelFrame,
      }),
    );
    expect(viewportRef.current.scrollToBottom).toHaveBeenCalledWith("jump-to-bottom");
    expect(viewportRef.current.scrollToItem).not.toHaveBeenCalled();
  });

  it("scrolls directly to a plain item's own row", () => {
    const viewportRef = { current: makeViewportHandle() };
    renderHook(() =>
      useTimelineSearchScroll({
        isOpen: true,
        matches: [makeMatch("message-1")],
        selectedIndex: 0,
        navigationRevision: 1,
        isLiveHeadItem: () => false,
        findGroupIdForItem: () => null,
        isGroupExpanded: () => false,
        expandGroup: vi.fn(),
        viewportRef,
        requestFrame: syncRequestFrame,
        cancelFrame: noopCancelFrame,
      }),
    );
    expect(viewportRef.current.scrollToItem).toHaveBeenCalledWith("message-1");
    expect(viewportRef.current.scrollToBottom).not.toHaveBeenCalled();
  });

  it("expands a collapsed tool-call group first, then scrolls to the group's host id once expanded", () => {
    const viewportRef = { current: makeViewportHandle() };
    const expandGroup = vi.fn();
    let isExpanded = false;

    const { rerender } = renderHook(
      (props: { isGroupExpanded: (groupId: string) => boolean }) =>
        useTimelineSearchScroll({
          isOpen: true,
          matches: [makeMatch("call-3")],
          selectedIndex: 0,
          navigationRevision: 1,
          isLiveHeadItem: () => false,
          findGroupIdForItem: (id) => (id === "call-3" ? "call-1" : null),
          isGroupExpanded: props.isGroupExpanded,
          expandGroup,
          viewportRef,
          requestFrame: syncRequestFrame,
          cancelFrame: noopCancelFrame,
        }),
      { initialProps: { isGroupExpanded: () => isExpanded } },
    );

    // First pass: not expanded yet -> requests expansion, does not scroll.
    expect(expandGroup).toHaveBeenCalledWith("call-1");
    expect(viewportRef.current.scrollToItem).not.toHaveBeenCalled();

    // Simulate the expansion state committing, then re-render.
    isExpanded = true;
    act(() => {
      rerender({ isGroupExpanded: () => isExpanded });
    });

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledWith("call-1");
  });

  it("does not re-scroll when matches identity changes but navigationRevision and the selected id stay the same", () => {
    const viewportRef = { current: makeViewportHandle() };
    // Stable across renders — an inline `vi.fn()`/arrow function in the
    // render callback below would get a fresh identity every rerender and
    // force the effect to re-run regardless of navigationRevision, which
    // would defeat the point of this test.
    const isLiveHeadItem = () => false;
    const findGroupIdForItem = () => null;
    const isGroupExpanded = () => false;
    const expandGroup = vi.fn();

    const { rerender } = renderHook(
      (props: { matches: TimelineSearchMatch[] }) =>
        useTimelineSearchScroll({
          isOpen: true,
          matches: props.matches,
          selectedIndex: 0,
          navigationRevision: 1,
          isLiveHeadItem,
          findGroupIdForItem,
          isGroupExpanded,
          expandGroup,
          viewportRef,
          requestFrame: syncRequestFrame,
          cancelFrame: noopCancelFrame,
        }),
      { initialProps: { matches: [makeMatch("message-1")] } },
    );

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);

    // Simulate refresh(): a brand-new matches array, same selected item id,
    // navigationRevision unchanged — this must NOT re-trigger a scroll.
    act(() => {
      rerender({ matches: [makeMatch("message-1")] });
    });

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);
  });

  it("skips the coarse row scroll when navigation stays within the same item", () => {
    const viewportRef = { current: makeViewportHandle() };

    const { rerender } = renderHook(
      (props: { navigationRevision: number }) =>
        useTimelineSearchScroll({
          isOpen: true,
          matches: [makeMatch("message-1")],
          selectedIndex: 0,
          navigationRevision: props.navigationRevision,
          isLiveHeadItem: () => false,
          findGroupIdForItem: () => null,
          isGroupExpanded: () => false,
          expandGroup: vi.fn(),
          viewportRef,
          requestFrame: syncRequestFrame,
          cancelFrame: noopCancelFrame,
        }),
      { initialProps: { navigationRevision: 1 } },
    );

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);

    act(() => {
      rerender({ navigationRevision: 2 });
    });

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);
  });

  it("does not re-fire when isLiveHeadItem/findGroupIdForItem/isGroupExpanded/expandGroup get fresh closures on every render without navigation (the scroll-hijack regression)", () => {
    const viewportRef = { current: makeViewportHandle() };

    // Simulates view.tsx: these are recreated on every ~48ms stream flush
    // and every unrelated tool-call-group toggle, but their *results* for
    // this item/group don't change between renders.
    const { rerender } = renderHook(
      (props: { renderCount: number }) =>
        useTimelineSearchScroll({
          isOpen: true,
          matches: [makeMatch("message-1")],
          selectedIndex: 0,
          navigationRevision: 1,
          isLiveHeadItem: (id) => id === `never-${props.renderCount}`,
          findGroupIdForItem: () => null,
          isGroupExpanded: () => false,
          expandGroup: vi.fn(),
          viewportRef,
          requestFrame: syncRequestFrame,
          cancelFrame: noopCancelFrame,
        }),
      { initialProps: { renderCount: 0 } },
    );

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);

    // Re-render several times with brand-new closures (a different
    // renderCount forces new function identities) and no navigation change.
    for (let renderCount = 1; renderCount <= 5; renderCount++) {
      act(() => {
        rerender({ renderCount });
      });
    }

    expect(viewportRef.current.scrollToItem).toHaveBeenCalledTimes(1);
  });
});
