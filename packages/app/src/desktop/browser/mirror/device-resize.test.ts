import { describe, expect, it } from "vitest";
import type { DeviceSizeSelection } from "@/desktop/browser/device-sizes";
import { resolveMirrorDeviceResize } from "./device-resize";

const responsive: DeviceSizeSelection = {
  id: "responsive",
  isLandscape: false,
  size: null,
};

describe("resolveMirrorDeviceResize", () => {
  it.each([
    [
      { id: "iphone-14", isLandscape: true, size: { width: 844, height: 390 } },
      { width: 640.4, height: 480.6 },
      { status: "resize", width: 844, height: 390 },
    ],
    [responsive, { width: 640.4, height: 480.6 }, { status: "resize", width: 640, height: 481 }],
    [responsive, null, { status: "unavailable" }],
    [responsive, { width: 0, height: 0 }, { status: "unavailable" }],
  ] satisfies Array<
    [
      DeviceSizeSelection,
      { width: number; height: number } | null,
      ReturnType<typeof resolveMirrorDeviceResize>,
    ]
  >)("resolves fixed, responsive, and unavailable sizes", (selection, paneSize, expected) => {
    expect(resolveMirrorDeviceResize({ selection, paneSize })).toEqual(expected);
  });
});
