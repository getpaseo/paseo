// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { LayoutChangeEvent } from "react-native";
import { describe, expect, it } from "vitest";
import { useContainerWidthBelow } from "./use-container-width";

function layoutEvent(width: number): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: {
        width,
        height: 48,
        x: 0,
        y: 0,
      },
    },
  } as LayoutChangeEvent;
}

describe("useContainerWidthBelow", () => {
  it("does not re-render for width changes that stay in the same threshold bucket", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useContainerWidthBelow(700);
    });

    expect(result.current.isBelow).toBe(true);
    expect(renderCount).toBe(1);

    act(() => {
      result.current.onLayout(layoutEvent(650));
      result.current.onLayout(layoutEvent(620));
      result.current.onLayout(layoutEvent(699));
    });

    expect(result.current.isBelow).toBe(true);
    expect(renderCount).toBe(1);
  });

  it("re-renders when the width crosses the threshold", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useContainerWidthBelow(700);
    });

    act(() => {
      result.current.onLayout(layoutEvent(760));
    });

    expect(result.current.isBelow).toBe(false);
    expect(renderCount).toBe(2);
  });
});
