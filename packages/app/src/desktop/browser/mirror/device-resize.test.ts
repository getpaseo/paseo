import { describe, expect, it } from "vitest";
import type { DeviceSizeSelection } from "@/desktop/browser/device-sizes";
import { resolveMirrorDeviceResize } from "./device-resize";

const PANE_SIZE = { width: 640.4, height: 480.6 };

function selection(input: Partial<DeviceSizeSelection>): DeviceSizeSelection {
  return { id: "responsive", isLandscape: false, size: null, ...input };
}

describe("resolveMirrorDeviceResize", () => {
  it("resizes the remote tab to the picked preset", () => {
    const resize = resolveMirrorDeviceResize({
      selection: selection({ id: "iphone-14", size: { width: 390, height: 844 } }),
      paneSize: PANE_SIZE,
    });

    expect(resize).toEqual({ status: "resize", width: 390, height: 844 });
  });

  it("resizes to the swapped dimensions once the preset is rotated", () => {
    const resize = resolveMirrorDeviceResize({
      selection: selection({
        id: "iphone-14",
        isLandscape: true,
        size: { width: 844, height: 390 },
      }),
      paneSize: PANE_SIZE,
    });

    expect(resize).toEqual({ status: "resize", width: 844, height: 390 });
  });

  it("sends this viewer's pane size for responsive, which has no remote equivalent", () => {
    const resize = resolveMirrorDeviceResize({
      selection: selection({}),
      paneSize: PANE_SIZE,
    });

    // The host only accepts whole pixels; a laid-out pane is fractional.
    expect(resize).toEqual({ status: "resize", width: 640, height: 481 });
  });

  it("has nothing to send for responsive before the pane is laid out", () => {
    const resize = resolveMirrorDeviceResize({ selection: selection({}), paneSize: null });

    expect(resize).toEqual({ status: "unavailable" });
  });

  it("has nothing to send for responsive in a pane that laid out at zero", () => {
    const resize = resolveMirrorDeviceResize({
      selection: selection({}),
      paneSize: { width: 0, height: 0 },
    });

    expect(resize).toEqual({ status: "unavailable" });
  });

  it("prefers the preset over the pane, so a fixed size ignores the window", () => {
    const resize = resolveMirrorDeviceResize({
      selection: selection({ id: "laptop", isLandscape: true, size: { width: 1366, height: 768 } }),
      paneSize: PANE_SIZE,
    });

    expect(resize).toEqual({ status: "resize", width: 1366, height: 768 });
  });
});
