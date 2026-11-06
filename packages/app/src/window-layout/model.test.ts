import { describe, expect, it } from "vitest";
import {
  resolveSafeAreaInsets,
  resolveTopBand,
  resolveTopBandClearance,
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

// Estimated, not measured: Duo inner portrait (669×951) with a ≈80pt rectangular top and a
// top-right status region 144pt wide (202pt with a Live Activity, from #7924's ActivityKit QA).
// The top bar's start (12pt) is a placeholder: the simulator boots folded and Xcode 27 ships
// no control to unfold it, so the inner screen's guide frame has not been measured.
const duo = {
  systemTop: 80,
  topBar: { x: 0, y: 12, width: 669, height: 44 },
  statusRegion: { x: 525, y: 0, width: 144, height: 80 },
  liveActivityRegion: { x: 467, y: 0, width: 202, height: 80 },
};

function duoLayout(occlusions: WindowLayoutRect[]): WindowLayout {
  return layout({
    bounds: { x: 0, y: 0, width: 669, height: 951 },
    topBar: duo.topBar,
    occlusions,
  });
}

describe("resolveTopBand", () => {
  it("publishes the top bar's start and the occlusions when the band is in use", () => {
    expect(resolveTopBand(duo.systemTop, duoLayout([duo.statusRegion]))).toEqual({
      top: 12,
      occlusions: [duo.statusRegion],
    });
  });

  it("ignores occlusions without a top bar guide (before iOS 27.1 or unresolved)", () => {
    const withoutGuide = layout({ topBar: null, occlusions: [duo.statusRegion] });
    expect(resolveTopBand(duo.systemTop, withoutGuide)).toBeNull();
    expect(resolveTopBand(duo.systemTop, layout({ occlusions: [duo.statusRegion] }))).toBeNull();
  });

  it("ignores occlusions when the top bar guide sits below the status region", () => {
    const below = layout({
      topBar: { x: 0, y: 80, width: 669, height: 44 },
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

describe("resolveTopBandClearance", () => {
  // The full workspace header with the sidebar closed spans the window.
  const fullHeader = { x: 0, y: duo.topBar.y, width: 669, height: 44 };
  // The compact header beside a 320pt sidebar: 8pt top padding, 56pt row.
  const compactHeader = { x: 320, y: duo.topBar.y + 8, width: 349, height: 56 };
  const compactMinimum = 12 + 44 + 8 + 96 + 8 + 132;

  it("trims the trailing side to the status region", () => {
    expect(
      resolveTopBandClearance({
        row: fullHeader,
        occlusions: [duo.statusRegion],
        minimumWidth: 300,
      }),
    ).toEqual({ trailing: 144, top: 0 });
  });

  it("trims further when a Live Activity widens the status region", () => {
    expect(
      resolveTopBandClearance({
        row: fullHeader,
        occlusions: [duo.liveActivityRegion],
        minimumWidth: 300,
      }),
    ).toEqual({ trailing: 202, top: 0 });
  });

  it("starts below the status region when the controls no longer fit beside it", () => {
    expect(
      resolveTopBandClearance({
        row: compactHeader,
        occlusions: [duo.statusRegion],
        minimumWidth: compactMinimum,
      }),
    ).toEqual({ trailing: 0, top: 60 });
  });

  it("starts below the lowest of several overlapping occlusions", () => {
    expect(
      resolveTopBandClearance({
        row: compactHeader,
        occlusions: [duo.statusRegion, { x: 600, y: 0, width: 69, height: 96 }],
        minimumWidth: compactMinimum,
      }),
    ).toEqual({ trailing: 0, top: 76 });
  });

  it("leaves rows alone that do not overlap an occlusion", () => {
    const sidebarRow = { x: 0, y: duo.topBar.y + 8, width: 320, height: 44 };
    const rowBelow = { x: 0, y: 80, width: 669, height: 44 };
    for (const row of [sidebarRow, rowBelow]) {
      expect(
        resolveTopBandClearance({ row, occlusions: [duo.statusRegion], minimumWidth: 0 }),
      ).toEqual({ trailing: 0, top: 0 });
    }
  });

  it("rounds a fractional clearance up so controls never touch the occlusion", () => {
    expect(
      resolveTopBandClearance({
        row: { x: 0, y: 10, width: 669.5, height: 44 },
        occlusions: [{ x: 525.25, y: 0, width: 144, height: 60.5 }],
        minimumWidth: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ trailing: 0, top: 51 });
    expect(
      resolveTopBandClearance({
        row: { x: 0, y: 10, width: 669.5, height: 44 },
        occlusions: [{ x: 525.25, y: 0, width: 144, height: 60.5 }],
        minimumWidth: 0,
      }).trailing,
    ).toBe(145);
  });
});
