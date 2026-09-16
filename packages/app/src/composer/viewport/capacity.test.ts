import { describe, expect, it } from "vitest";
import { resolveComposerCapacity, updateComposerCapacity } from "./capacity";

describe("composer viewport", () => {
  it("preserves the editing capacity when the keyboard closes on a docked composer", () => {
    const viewport = { height: 582, bottomInset: 24, centered: false };
    const open = updateComposerCapacity(undefined, { ...viewport, keyboardShift: 308 }, "retain");
    const closed = updateComposerCapacity(open, { ...viewport, keyboardShift: 0 }, "retain");
    expect(open.capacity).toBe(245);
    expect(closed.capacity).toBe(open.capacity);
    expect(
      updateComposerCapacity(closed, { ...viewport, keyboardShift: 250 }, "retain").capacity,
    ).toBe(303);
  });

  it("releases the whole viewport when the keyboard closes on a form", () => {
    const viewport = { height: 582, bottomInset: 24, centered: false };
    const open = updateComposerCapacity(undefined, { ...viewport, keyboardShift: 308 }, "release");
    const closed = updateComposerCapacity(open, { ...viewport, keyboardShift: 0 }, "release");
    expect(open.capacity).toBe(245);
    expect(closed.capacity).toBe(553);
    expect(
      updateComposerCapacity(closed, { ...viewport, keyboardShift: 308 }, "release").capacity,
    ).toBe(245);
  });

  it("remeasures the viewport without forgetting the keyboard reservation", () => {
    const open = updateComposerCapacity(
      undefined,
      { height: 582, bottomInset: 24, centered: false, keyboardShift: 308 },
      "retain",
    );
    expect(
      updateComposerCapacity(
        open,
        { height: 650, bottomInset: 24, centered: false, keyboardShift: 0 },
        "retain",
      ).capacity,
    ).toBe(313);
    expect(
      updateComposerCapacity(
        open,
        { height: 0, bottomInset: 24, centered: false, keyboardShift: 0 },
        "retain",
      ),
    ).toEqual(open);
  });
  it("leaves five points below the header for a bottom-anchored composer", () => {
    const height = resolveComposerCapacity({
      height: 582,
      bottomInset: 24,
      keyboardShift: 308,
      centered: false,
    });
    expect(height).toBe(245);
    expect(582 - 24 - 308 - height).toBe(5);
  });

  it("keeps a centered tablet form below the header after translation", () => {
    const height = resolveComposerCapacity({
      height: 1000,
      bottomInset: 80,
      keyboardShift: 300,
      centered: true,
    });
    expect(height).toBe(310);
    expect((1000 - 80 - height) / 2 - 300).toBe(5);
  });

  it("uses the measured viewport before the first keyboard opening", () => {
    expect(
      resolveComposerCapacity({ height: 582, bottomInset: 24, keyboardShift: 0, centered: false }),
    ).toBe(553);
    expect(
      resolveComposerCapacity({ height: 300, bottomInset: 0, keyboardShift: 200, centered: false }),
    ).toBe(95);
  });
});
