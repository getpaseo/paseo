import { describe, expect, it } from "vitest";
import {
  resolveMobileSidebarPersistedWidth,
  resolveMobileSidebarWidth,
} from "@/components/mobile-sidebar-layout";

describe("mobile sidebar layout", () => {
  it("fills the window until a width is chosen", () => {
    expect(resolveMobileSidebarWidth({ requestedWidth: null, windowWidth: 390 })).toBe(390);
  });

  it("clamps a chosen width between the minimum and the window", () => {
    expect(resolveMobileSidebarWidth({ requestedWidth: 100, windowWidth: 390 })).toBe(240);
    expect(resolveMobileSidebarWidth({ requestedWidth: 300, windowWidth: 390 })).toBe(300);
    expect(resolveMobileSidebarWidth({ requestedWidth: 500, windowWidth: 390 })).toBe(390);
  });

  it("never exceeds a window narrower than the minimum", () => {
    expect(resolveMobileSidebarWidth({ requestedWidth: 300, windowWidth: 200 })).toBe(200);
  });

  it("settles near-full widths back to filling the window", () => {
    expect(resolveMobileSidebarPersistedWidth({ width: 380, windowWidth: 390 })).toBeNull();
    expect(resolveMobileSidebarPersistedWidth({ width: 300, windowWidth: 390 })).toBe(300);
  });
});
