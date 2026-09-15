import { describe, expect, it } from "vitest";
import {
  bottomOverlayClearancesEqual,
  resolveBottomOverlayTailInset,
  shouldAnchorForBottomOverlayAppearance,
} from "./bottom-overlay-inset";

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

describe("bottomOverlayClearancesEqual", () => {
  it("invalidates the stream when either floating-overlay clearance changes", () => {
    const baseline = {
      bottomOverlayTailClearance: 0,
      bottomOverlayControlClearance: 0,
    };

    expect(bottomOverlayClearancesEqual(baseline, { ...baseline })).toBe(true);
    expect(
      bottomOverlayClearancesEqual(baseline, {
        ...baseline,
        bottomOverlayTailClearance: 64,
      }),
    ).toBe(false);
    expect(
      bottomOverlayClearancesEqual(baseline, {
        ...baseline,
        bottomOverlayControlClearance: 48,
      }),
    ).toBe(false);
  });
});

describe("shouldAnchorForBottomOverlayAppearance", () => {
  it("anchors only when a bottom overlay first appears while following output", () => {
    expect(shouldAnchorForBottomOverlayAppearance(0, 64, true)).toBe(true);
    expect(shouldAnchorForBottomOverlayAppearance(0, 64, false)).toBe(false);
    expect(shouldAnchorForBottomOverlayAppearance(64, 64, true)).toBe(false);
    expect(shouldAnchorForBottomOverlayAppearance(64, 72, true)).toBe(false);
    expect(shouldAnchorForBottomOverlayAppearance(64, 0, true)).toBe(false);
  });
});
