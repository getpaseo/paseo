/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useLatchedBoolean } from "./use-latched-boolean";

describe("useLatchedBoolean", () => {
  it("stays true after the input first becomes true", () => {
    const { result, rerender } = renderHook(({ value }) => useLatchedBoolean(value), {
      initialProps: { value: false },
    });

    expect(result.current).toBe(false);

    rerender({ value: true });
    expect(result.current).toBe(true);

    rerender({ value: false });
    expect(result.current).toBe(true);
  });
});
