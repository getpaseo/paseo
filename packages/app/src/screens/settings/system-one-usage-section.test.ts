import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./system-one-usage-section";

describe("formatTokenCount", () => {
  it("keeps small counts exact and compacts large ones", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(3410)).toBe("3.4k");
    expect(formatTokenCount(48_700)).toBe("49k");
    expect(formatTokenCount(2_350_000)).toBe("2.4M");
  });
});
