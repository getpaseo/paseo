import { describe, expect, it } from "vitest";
import {
  resolveCenteredClearance,
  resolveComposerBottomPlacement,
  resolveComposerSlotCapacity,
  resolveInlineComposerCapacity,
  resolveComposerCapacity,
  updateComposerCapacity,
} from "./capacity";

describe("composer bottom placement", () => {
  const keyboardHeight = 264;
  /** Keyboard top minus composer bottom, both measured up from the window bottom. */
  function keyboardGapAbove(safeAreaBottom: number): number {
    const placement = resolveComposerBottomPlacement({ safeAreaBottom, contentSpacing: 16 });
    const shift = keyboardHeight - safeAreaBottom;
    const lift = shift + Math.min(placement.keyboardGap, shift);
    return placement.restingPadding + lift - keyboardHeight;
  }

  it("rests at the bottom clearance without stacking a second gutter", () => {
    expect(resolveComposerBottomPlacement({ safeAreaBottom: 34, contentSpacing: 16 })).toEqual({
      restingPadding: 34,
      keyboardGap: 16,
    });
    expect(
      resolveComposerBottomPlacement({ safeAreaBottom: 24, contentSpacing: 16 }).restingPadding,
    ).toBe(24);
  });

  it.each([0, 20, 34])("never rests closer to the edge than the content spacing (%s)", (inset) => {
    expect(
      resolveComposerBottomPlacement({ safeAreaBottom: inset, contentSpacing: 16 }).restingPadding,
    ).toBe(Math.max(inset, 16));
  });

  it("keeps a measured zero clearance at the content spacing", () => {
    expect(resolveComposerBottomPlacement({ safeAreaBottom: 0, contentSpacing: 16 })).toEqual({
      restingPadding: 16,
      keyboardGap: 0,
    });
  });

  it.each([0, 20, 24, 34])("keeps the content spacing above the keyboard (%s)", (inset) => {
    expect(keyboardGapAbove(inset)).toBe(16);
  });

  it("reserves the gap's extra rise out of the docked composer's capacity", () => {
    const viewport = { height: 582, bottomInset: 0, safeAreaBottom: 34, centered: false };
    const closed = resolveComposerCapacity({ ...viewport, keyboardShift: 0, keyboardGap: 16 });
    const open = resolveComposerCapacity({ ...viewport, keyboardShift: 230, keyboardGap: 16 });
    expect(closed).toBe(577);
    expect(open).toBe(331);
  });
});

describe("composer viewport", () => {
  it("caps the complete compact composer at sixty percent of keyboard-reserved space", () => {
    const open = updateComposerCapacity(undefined, {
      height: 582,
      bottomInset: 24,
      safeAreaBottom: 0,
      keyboardGap: 0,
      centered: false,
      keyboardShift: 308,
    });
    expect(resolveInlineComposerCapacity(open.capacity, true)).toBe(147);
    expect(resolveInlineComposerCapacity(open.capacity, false)).toBe(245);
    expect(resolveInlineComposerCapacity(undefined, true)).toBeUndefined();
  });
  it("lets a fullscreen composer fill the viewport while inline keeps its cap", () => {
    const open = updateComposerCapacity(undefined, {
      height: 582,
      bottomInset: 24,
      safeAreaBottom: 0,
      keyboardGap: 0,
      centered: false,
      keyboardShift: 308,
    });
    expect(resolveComposerSlotCapacity(open, { compact: true, fullscreen: true })).toBe(582);
    expect(resolveComposerSlotCapacity(open, { compact: true, fullscreen: false })).toBe(147);
    expect(resolveComposerSlotCapacity(undefined, { compact: true, fullscreen: true })).toBe(
      undefined,
    );
  });
  it("preserves the editing capacity when the keyboard closes", () => {
    const viewport = {
      height: 582,
      bottomInset: 24,
      safeAreaBottom: 0,
      keyboardGap: 0,
      centered: false,
    };
    const open = updateComposerCapacity(undefined, { ...viewport, keyboardShift: 308 });
    const closed = updateComposerCapacity(open, { ...viewport, keyboardShift: 0 });
    expect(open.capacity).toBe(245);
    expect(closed.capacity).toBe(open.capacity);
    expect(updateComposerCapacity(closed, { ...viewport, keyboardShift: 250 }).capacity).toBe(303);
  });

  it("remeasures the viewport without forgetting the keyboard reservation", () => {
    const open = updateComposerCapacity(undefined, {
      height: 582,
      bottomInset: 24,
      safeAreaBottom: 0,
      keyboardGap: 0,
      centered: false,
      keyboardShift: 308,
    });
    expect(
      updateComposerCapacity(open, {
        height: 650,
        bottomInset: 24,
        safeAreaBottom: 0,
        keyboardGap: 0,
        centered: false,
        keyboardShift: 0,
      }).capacity,
    ).toBe(313);
    expect(
      updateComposerCapacity(open, {
        height: 0,
        bottomInset: 24,
        safeAreaBottom: 0,
        keyboardGap: 0,
        centered: false,
        keyboardShift: 0,
      }),
    ).toEqual(open);
  });
  it("leaves five points below the header for a bottom-anchored composer", () => {
    const height = resolveComposerCapacity({
      height: 582,
      bottomInset: 24,
      safeAreaBottom: 0,
      keyboardShift: 308,
      keyboardGap: 0,
      centered: false,
    });
    expect(height).toBe(245);
    expect(582 - 24 - 308 - height).toBe(5);
  });

  it("keeps a centered tablet form below the header once the keyboard reaches it", () => {
    const viewport = 1000;
    const bottomInset = 80;
    const keyboardShift = 300;
    const height = resolveComposerCapacity({
      height: viewport,
      bottomInset,
      safeAreaBottom: 0,
      keyboardShift,
      keyboardGap: 0,
      centered: true,
    });
    expect(height).toBe(695);
    const restingTop = (viewport - bottomInset - height) / 2;
    const bottomClearance = resolveCenteredClearance({
      viewportHeight: viewport,
      safeAreaBottom: 0,
      formBottom: restingTop + height,
    });
    expect(restingTop - Math.max(0, keyboardShift - bottomClearance)).toBe(5);
  });

  it("leaves a centered form room to edit on a short foldable viewport", () => {
    expect(
      resolveComposerCapacity({
        height: 725,
        bottomInset: 72,
        safeAreaBottom: 0,
        keyboardShift: 313,
        keyboardGap: 0,
        centered: true,
      }),
    ).toBe(407);
  });

  it("rests a centered form on the keyboard above the bottom safe area", () => {
    // The keyboard shift excludes the safe area that the keyboard also covers.
    const geometry = {
      height: 660,
      bottomInset: 60,
      safeAreaBottom: 32,
      keyboardShift: 288,
      keyboardGap: 0,
      centered: true,
    };
    const height = resolveComposerCapacity(geometry);
    const restingTop = (geometry.height - geometry.bottomInset - height) / 2;
    const formBottom = restingTop + height;
    const clearance = resolveCenteredClearance({
      viewportHeight: geometry.height,
      safeAreaBottom: geometry.safeAreaBottom,
      formBottom,
    });
    const translation = Math.max(0, geometry.keyboardShift - clearance);
    const keyboardTop = geometry.height - geometry.safeAreaBottom - geometry.keyboardShift;
    expect(formBottom - translation).toBe(keyboardTop);
    expect(restingTop - translation).toBe(5);
  });

  it("uses the measured viewport before the first keyboard opening", () => {
    expect(
      resolveComposerCapacity({
        height: 582,
        bottomInset: 24,
        safeAreaBottom: 0,
        keyboardShift: 0,
        keyboardGap: 0,
        centered: false,
      }),
    ).toBe(553);
    expect(
      resolveComposerCapacity({
        height: 300,
        bottomInset: 0,
        safeAreaBottom: 0,
        keyboardShift: 200,
        keyboardGap: 0,
        centered: false,
      }),
    ).toBe(95);
  });
});
