// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMountedTabSet } from "./use-mounted-tab-set";

function mountedIds(result: { current: ReturnType<typeof useMountedTabSet> }): string[] {
  return Array.from(result.current.mountedTabIds);
}

describe("useMountedTabSet", () => {
  it("includes a newly active tab in the same render", () => {
    let renderCount = 0;
    const { result, rerender } = renderHook(
      ({ activeTabId }) => {
        renderCount += 1;
        return useMountedTabSet({
          activeTabId,
          allTabIds: ["first", "second"],
          cap: 3,
        });
      },
      { initialProps: { activeTabId: "first" } },
    );

    expect(mountedIds(result)).toEqual(["first"]);
    expect(renderCount).toBe(1);

    rerender({ activeTabId: "second" });

    expect(mountedIds(result)).toEqual(["second", "first"]);
    expect(renderCount).toBe(2);
  });

  it("preserves the cap while synchronously adding the active tab", () => {
    const { result, rerender } = renderHook(
      ({ activeTabId }) =>
        useMountedTabSet({
          activeTabId,
          allTabIds: ["first", "second", "third"],
          cap: 2,
        }),
      { initialProps: { activeTabId: "first" } },
    );

    rerender({ activeTabId: "second" });
    expect(mountedIds(result)).toEqual(["second", "first"]);

    rerender({ activeTabId: "third" });
    expect(mountedIds(result)).toEqual(["third", "second"]);
  });

  it("keeps retained panels mounted beyond the normal cap", () => {
    const { result, rerender } = renderHook(
      ({ activeTabId }) =>
        useMountedTabSet({
          activeTabId,
          allTabIds: ["modified", "second", "third", "fourth"],
          retainedTabIds: new Set(["modified"]),
          cap: 2,
        }),
      { initialProps: { activeTabId: "modified" } },
    );

    rerender({ activeTabId: "second" });
    rerender({ activeTabId: "third" });
    rerender({ activeTabId: "fourth" });

    expect(mountedIds(result)).toEqual(["fourth", "modified"]);
  });
});
