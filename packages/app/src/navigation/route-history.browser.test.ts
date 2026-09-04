import { describe, expect, it, vi } from "vitest";
import { navigateRouteHistory } from "./route-history";

describe("navigateRouteHistory", () => {
  it.each([
    ["back", "back"],
    ["forward", "forward"],
  ] as const)("uses browser history for %s navigation", (direction, method) => {
    const historyMethod = vi.spyOn(window.history, method).mockImplementation(() => undefined);

    expect(navigateRouteHistory(direction)).toBe(true);
    expect(historyMethod).toHaveBeenCalledOnce();

    historyMethod.mockRestore();
  });
});
