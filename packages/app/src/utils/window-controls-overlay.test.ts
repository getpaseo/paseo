import { describe, expect, it } from "vitest";
import { resolveWindowControlsOverlayInsets } from "@/utils/window-controls-overlay";

describe("resolveWindowControlsOverlayInsets", () => {
  it("resolves Windows right-hand controls geometry", () => {
    const insets = resolveWindowControlsOverlayInsets({
      titlebarAreaRect: { x: 0, y: 0, width: 1060, height: 29 },
      viewportWidth: 1200,
    });
    expect(insets).toEqual({ leftWidth: 0, rightWidth: 140, height: 29 });
  });

  it("resolves left-hand controls geometry for GNOME/KDE layouts", () => {
    const insets = resolveWindowControlsOverlayInsets({
      titlebarAreaRect: { x: 120, y: 0, width: 1080, height: 30 },
      viewportWidth: 1200,
    });
    expect(insets).toEqual({ leftWidth: 120, rightWidth: 0, height: 30 });
  });

  it("resolves layouts with controls on both sides", () => {
    const insets = resolveWindowControlsOverlayInsets({
      titlebarAreaRect: { x: 100, y: 0, width: 950, height: 32 },
      viewportWidth: 1200,
    });
    expect(insets).toEqual({ leftWidth: 100, rightWidth: 150, height: 32 });
  });

  it("rounds fractional values produced by device-pixel-ratio scaling", () => {
    const insets = resolveWindowControlsOverlayInsets({
      titlebarAreaRect: { x: 79.6, y: 0, width: 1000.1, height: 28.6 },
      viewportWidth: 1200.2,
    });
    expect(insets).toEqual({ leftWidth: 80, rightWidth: 121, height: 29 });
  });

  it("returns null for non-finite inputs", () => {
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: Number.NaN, y: 0, width: 1000, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: Number.POSITIVE_INFINITY, width: 1000, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: Number.NEGATIVE_INFINITY, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: Number.NaN },
        viewportWidth: 1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: 29 },
        viewportWidth: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: 29 },
        viewportWidth: Number.NaN,
      }),
    ).toBeNull();
  });

  it("returns null for non-positive viewport width or height", () => {
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: 29 },
        viewportWidth: 0,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: 29 },
        viewportWidth: -1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: 0 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1000, height: -29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
  });

  it("returns null for negative rect width", () => {
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: -10, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
  });

  it("returns null for a strip read mid-resize", () => {
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: -20, y: 0, width: 1200, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();

    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1300, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
  });

  it("returns null when the strip spans the whole window", () => {
    // Visible controls that occupy no width say nothing about where they are, so the caller
    // has to keep its fallback rather than reserve zero.
    expect(
      resolveWindowControlsOverlayInsets({
        titlebarAreaRect: { x: 0, y: 0, width: 1200, height: 29 },
        viewportWidth: 1200,
      }),
    ).toBeNull();
  });
});
