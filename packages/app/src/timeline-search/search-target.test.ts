// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTimelineSearchTargetValue } from "./search-target";

const matches = [
  {
    item: { id: "message-1" },
    field: "text" as const,
    fieldOffset: 4,
    matchOffset: 4,
    matchLength: 6,
  },
  {
    item: { id: "tool-1" },
    field: "toolOutput" as const,
    fieldOffset: 27,
    matchOffset: 42,
    matchLength: 6,
  },
];

describe("useTimelineSearchTargetValue", () => {
  it("publishes the selected occurrence in its field-relative coordinate frame", () => {
    const { result } = renderHook(() =>
      useTimelineSearchTargetValue({
        isOpen: true,
        selectedIndex: 1,
        navigationRevision: 8,
        matches,
      }),
    );

    expect(result.current).toEqual({
      itemId: "tool-1",
      field: "toolOutput",
      fieldOffset: 27,
      matchOffset: 42,
      matchLength: 6,
      navigationRevision: 8,
    });
  });

  it("withholds a target while closed or when selection is absent", () => {
    const { result, rerender } = renderHook(
      (state: { isOpen: boolean; selectedIndex: number }) =>
        useTimelineSearchTargetValue({ ...state, navigationRevision: 1, matches }),
      { initialProps: { isOpen: false, selectedIndex: 0 } },
    );

    expect(result.current).toBeNull();
    rerender({ isOpen: true, selectedIndex: -1 });
    expect(result.current).toBeNull();
  });

  it("keeps its identity across unrelated model state updates", () => {
    const { result, rerender } = renderHook(
      (state: { query: string }) =>
        useTimelineSearchTargetValue({
          isOpen: true,
          selectedIndex: 0,
          navigationRevision: 3,
          matches,
          ...state,
        }),
      { initialProps: { query: "first" } },
    );
    const initialTarget = result.current;

    rerender({ query: "second" });

    expect(result.current).toBe(initialTarget);
  });
});
