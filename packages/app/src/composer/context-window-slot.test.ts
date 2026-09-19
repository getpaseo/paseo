import { describe, expect, it } from "vitest";
import { shouldRenderCompactContextWindowSlot } from "./context-window-slot";

describe("shouldRenderCompactContextWindowSlot", () => {
  it("reserves a compact slot for an active agent", () => {
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: true,
        hasAgent: true,
      }),
    ).toBe(true);
  });

  it("does not reserve a slot outside a compact active-agent composer", () => {
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: false,
        hasAgent: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderCompactContextWindowSlot({
        isCompactLayout: true,
        hasAgent: false,
      }),
    ).toBe(false);
  });
});
