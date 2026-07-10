import { describe, expect, it } from "vitest";
import { resolveDesktopSidebarWidth } from "@/components/left-sidebar-width";

describe("desktop sidebar width", () => {
  it("clamps a persisted wide sidebar to preserve 400px of content", () => {
    const atHalfScreen = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 751 });
    expect(atHalfScreen).toBe(351);
    expect(751 - atHalfScreen).toBe(400);

    const atBreakpoint = resolveDesktopSidebarWidth({ requestedWidth: 600, viewportWidth: 720 });
    expect(atBreakpoint).toBe(320);
    expect(720 - atBreakpoint).toBe(400);
  });
});
