import { describe, expect, it } from "vitest";
import { resolveBottomOverlayTailInset } from "./bottom-overlay-inset";

describe("resolveBottomOverlayTailInset", () => {
  it("adds only the space missing after existing footer clearance", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 24,
      }),
    ).toBe(32);
  });

  it("reserves the full overlay and clearance when the tail has no spacing", () => {
    expect(
      resolveBottomOverlayTailInset({
        requiredTailClearance: 56,
        existingTailSpacing: 0,
      }),
    ).toBe(56);
  });
});
