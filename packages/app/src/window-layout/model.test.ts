import { describe, expect, it } from "vitest";
import {
  resolveSafeAreaInsets,
  resolveTopBand,
  type WindowLayout,
  type WindowLayoutRect,
} from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(input: Partial<WindowLayout> = {}): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    verticalBarEdge: "none",
    verticalBar: null,
    divisions: [],
    ...input,
  };
}

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: 24 }))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: 0 })).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout({ bottomClearance: value }))).toBe(
      systemInsets,
    );
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });

  it("starts the top where the top bar rests when it sits above the system top", () => {
    const insets = resolveSafeAreaInsets(
      systemInsets,
      layout({ topBar: { x: 0, y: 12, width: 402, height: 44 } }),
    );
    expect(insets).toEqual({ ...systemInsets, top: 12 });
  });

  it("keeps the system top when the top bar rests at or below it", () => {
    const insets = resolveSafeAreaInsets(
      systemInsets,
      layout({ topBar: { x: 0, y: 59, width: 402, height: 44 } }),
    );
    expect(insets).toBe(systemInsets);
  });
});

// Measured: iPhone Duo inner screen, portrait (669×951), iOS 27.1 simulator unfolded in
// DeviceHub.
const duo = {
  systemTop: 82,
  topBar: { x: 16, y: 26, width: 509, height: 44 },
  statusRegion: { x: 525, y: 0, width: 144, height: 82 },
};

function duoLayout(occlusions: WindowLayoutRect[]): WindowLayout {
  return layout({
    bounds: { x: 0, y: 0, width: 669, height: 951 },
    topBar: duo.topBar,
    occlusions,
  });
}

describe("resolveTopBand", () => {
  it("publishes the top bar's start and the status region past its trailing end", () => {
    expect(resolveTopBand(duo.systemTop, duoLayout([duo.statusRegion]))).toEqual({
      top: 26,
      trailingObstruction: { width: 144, height: 56 },
    });
  });

  it("reaches as low as the deepest occlusion beside the bar", () => {
    const deeper = { x: 600, y: 0, width: 69, height: 96 };
    expect(
      resolveTopBand(duo.systemTop, duoLayout([duo.statusRegion, deeper]))?.trailingObstruction,
    ).toEqual({ width: 144, height: 70 });
  });

  it("rounds a fractional obstruction up so controls never touch the status region", () => {
    const fractional = layout({
      bounds: { x: 0, y: 0, width: 669, height: 951 },
      topBar: { x: 16, y: 26, width: 509.25, height: 44 },
      occlusions: [{ x: 525.25, y: 0, width: 143.75, height: 82.5 }],
    });
    expect(resolveTopBand(duo.systemTop, fractional)?.trailingObstruction).toEqual({
      width: 144,
      height: 57,
    });
  });

  it("has no trailing obstruction when the bar reaches the window's trailing edge", () => {
    const fullWidth = layout({
      bounds: { x: 0, y: 0, width: 669, height: 951 },
      topBar: { x: 0, y: 26, width: 669, height: 44 },
    });
    expect(resolveTopBand(duo.systemTop, fullWidth)).toEqual({
      top: 26,
      trailingObstruction: null,
    });
  });

  it("ignores occlusions without a top bar guide (before iOS 27.1 or unresolved)", () => {
    const withoutGuide = layout({ topBar: null, occlusions: [duo.statusRegion] });
    expect(resolveTopBand(duo.systemTop, withoutGuide)).toBeNull();
    expect(resolveTopBand(duo.systemTop, layout({ occlusions: [duo.statusRegion] }))).toBeNull();
  });

  it("ignores occlusions when the top bar guide sits below the status region", () => {
    const below = layout({
      topBar: { x: 16, y: 82, width: 637, height: 44 },
      occlusions: [duo.statusRegion],
    });
    expect(resolveTopBand(duo.systemTop, below)).toBeNull();
  });

  // Measured: iPhone 17 Pro, iOS 27.2 simulator, portrait.
  it("is null on a regular iPhone, whose top bar starts at the status bar's bottom", () => {
    const iphone = layout({
      topBar: { x: 18, y: 62, width: 366, height: 44 },
      occlusions: [{ x: 0, y: 0, width: 402, height: 54 }],
    });
    expect(resolveTopBand(62, iphone)).toBeNull();
  });

  // Measured: iPhone Duo outer screen, iOS 27.1 simulator. The status region is a trailing
  // column, which the vertical bar layout already owns.
  it("is null on the Duo outer screen, whose top bar starts below a zero system top", () => {
    const outer = layout({
      bounds: { x: 0, y: 0, width: 466, height: 678 },
      verticalBarEdge: "trailing",
      topBar: { x: 7 / 3, y: 26, width: 1139 / 3, height: 44 },
      occlusions: [
        { x: 1199 / 3, y: 88 / 3, width: 37, height: 37 },
        { x: 382, y: 0, width: 84, height: 174 },
      ],
    });
    expect(resolveTopBand(0, outer)).toBeNull();
  });

  it("is null before the native layout arrives", () => {
    expect(resolveTopBand(duo.systemTop, null)).toBeNull();
  });
});
