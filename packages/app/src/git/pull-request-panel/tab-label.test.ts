import { describe, expect, it } from "vitest";
import { formatPrTabLabel } from "./tab-label";

describe("formatPrTabLabel", () => {
  it("returns #<number> when a pull request number is present", () => {
    expect(formatPrTabLabel(42)).toBe("#42");
  });

  it("returns #— fallback when the pull request number is null", () => {
    expect(formatPrTabLabel(null)).toBe("#—");
  });
});
