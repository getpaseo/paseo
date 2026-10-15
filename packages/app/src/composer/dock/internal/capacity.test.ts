import { describe, expect, it } from "vitest";
import {
  resolveCenteredClearance,
  resolveComposerCapacity,
  updateComposerCapacity,
} from "./capacity";

describe("composer viewport", () => {
  it("preserves the editing capacity when the keyboard closes", () => {
    const viewport = { height: 582, bottomInset: 24, safeAreaBottom: 0, centered: false };
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
      centered: false,
      keyboardShift: 308,
    });
    expect(
      updateComposerCapacity(open, {
        height: 650,
        bottomInset: 24,
        safeAreaBottom: 0,
        centered: false,
        keyboardShift: 0,
      }).capacity,
    ).toBe(313);
    expect(
      updateComposerCapacity(open, {
        height: 0,
        bottomInset: 24,
        safeAreaBottom: 0,
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
        centered: false,
      }),
    ).toBe(553);
    expect(
      resolveComposerCapacity({
        height: 300,
        bottomInset: 0,
        safeAreaBottom: 0,
        keyboardShift: 200,
        centered: false,
      }),
    ).toBe(95);
  });
});
