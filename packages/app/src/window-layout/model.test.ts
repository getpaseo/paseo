import { describe, expect, it } from "vitest";
import { resolveHeaderBesideStatusBar, resolveSafeAreaInsets, type WindowLayout } from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(bottomClearance: number | null | undefined): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    verticalBarEdge: "none",
    verticalBar: null,
    bottomClearance,
    divisions: [],
  };
}

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(24))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(0)).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout(value))).toBe(systemInsets);
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });
});

describe("resolveHeaderBesideStatusBar", () => {
  const base = {
    bounds: { x: 0, y: 0, width: 449, height: 900 },
    verticalBarEdge: "none" as const,
    verticalBar: null,
    divisions: [],
  };

  it("moves the header into the top row, ending before a status pill at the top right", () => {
    expect(
      resolveHeaderBesideStatusBar(
        {
          ...base,
          verticalBarBehavior: "disabled",
          statusBar: { x: 280, y: 25, width: 145, height: 46 },
        },
        44,
      ),
    ).toEqual({ top: 26, right: 177 });
  });

  it("uses the occluded region at the top right when the status bar reports full width", () => {
    expect(
      resolveHeaderBesideStatusBar(
        {
          ...base,
          verticalBarBehavior: "disabled",
          statusBar: { x: 0, y: 0, width: 449, height: 54 },
          occlusions: [{ x: 274, y: 20, width: 151, height: 56 }],
        },
        44,
      ),
    ).toEqual({ top: 26, right: 183 });
  });

  it("keeps the header below the inset for a full-width status bar or an active vertical bar", () => {
    const wide = { x: 0, y: 0, width: 449, height: 54 };
    const pill = { x: 280, y: 25, width: 145, height: 46 };
    expect(
      resolveHeaderBesideStatusBar(
        { ...base, verticalBarBehavior: "disabled", statusBar: wide },
        44,
      ),
    ).toBeNull();
    expect(
      resolveHeaderBesideStatusBar(
        { ...base, verticalBarBehavior: "automatic", statusBar: pill },
        44,
      ),
    ).toBeNull();
    expect(resolveHeaderBesideStatusBar(null, 44)).toBeNull();
  });
});
