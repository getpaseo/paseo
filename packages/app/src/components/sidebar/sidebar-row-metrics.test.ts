import { describe, expect, it } from "vitest";
import { resolveSidebarRowDensity } from "./sidebar-row-metrics";

describe("resolveSidebarRowDensity", () => {
  it("materially reduces row height and vertical padding in compact mode", () => {
    const comfortable = resolveSidebarRowDensity({ compact: false, spacing: { 1: 4, 2: 8 } });
    const compact = resolveSidebarRowDensity({ compact: true, spacing: { 1: 4, 2: 8 } });

    expect(comfortable).toEqual({ minHeight: 36, paddingVertical: 8 });
    expect(compact).toEqual({ minHeight: 28, paddingVertical: 4 });
    expect(compact.minHeight).toBeLessThan(comfortable.minHeight);
    expect(compact.paddingVertical).toBeLessThan(comfortable.paddingVertical);
  });
});
