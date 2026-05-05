import { describe, expect, it } from "vitest";
import { isCompactBreakpoint, isWorkspaceCompactBreakpoint } from "./layout";

describe("layout breakpoint helpers", () => {
  it("keeps the app-wide compact breakpoint at phone widths", () => {
    expect(isCompactBreakpoint("xs")).toBe(true);
    expect(isCompactBreakpoint("sm")).toBe(true);
    expect(isCompactBreakpoint("md")).toBe(false);
    expect(isCompactBreakpoint("lg")).toBe(false);
    expect(isCompactBreakpoint(undefined)).toBe(false);
  });

  it("treats md workspace widths as compact for pane-heavy screens", () => {
    expect(isWorkspaceCompactBreakpoint("xs")).toBe(true);
    expect(isWorkspaceCompactBreakpoint("sm")).toBe(true);
    expect(isWorkspaceCompactBreakpoint("md")).toBe(true);
    expect(isWorkspaceCompactBreakpoint("lg")).toBe(false);
    expect(isWorkspaceCompactBreakpoint(undefined)).toBe(false);
  });
});
