import { describe, expect, it } from "vitest";
import {
  DEVICE_SIZE_PRESETS,
  formatDevicePresetLabel,
  isPresetLandscape,
  orientedSize,
  type DeviceSizeId,
  type DeviceSizePreset,
} from "./device-sizes";

function preset(id: DeviceSizeId): DeviceSizePreset {
  const match = DEVICE_SIZE_PRESETS.find((candidate) => candidate.id === id);
  if (!match) {
    throw new Error(`no device preset "${id}"`);
  }
  return match;
}

const RESPONSIVE_LABEL = "Responsive";

describe("orientedSize", () => {
  it("keeps an upright preset upright", () => {
    expect(orientedSize(preset("iphone-14"), false)).toEqual({ width: 390, height: 844 });
  });

  it("swaps an upright preset for landscape", () => {
    expect(orientedSize(preset("iphone-14"), true)).toEqual({ width: 844, height: 390 });
  });

  it("keeps a preset that is already landscape the way round it is stored", () => {
    expect(orientedSize(preset("laptop"), true)).toEqual({ width: 1366, height: 768 });
  });

  it("stands a landscape preset up when asked for portrait", () => {
    expect(orientedSize(preset("laptop"), false)).toEqual({ width: 768, height: 1366 });
  });

  it("has no size for responsive, which takes the shape of whatever it is given", () => {
    expect(orientedSize(preset("responsive"), false)).toBeNull();
    expect(orientedSize(preset("responsive"), true)).toBeNull();
  });
});

describe("isPresetLandscape", () => {
  it("reads the stored orientation of a preset", () => {
    expect(isPresetLandscape(preset("iphone-14"))).toBe(false);
    expect(isPresetLandscape(preset("laptop"))).toBe(true);
  });

  it("calls responsive portrait, because it has no orientation to report", () => {
    expect(isPresetLandscape(preset("responsive"))).toBe(false);
  });
});

describe("formatDevicePresetLabel", () => {
  it("shows the dimensions the preset will apply", () => {
    const iphone = preset("iphone-14");

    expect(formatDevicePresetLabel(iphone, RESPONSIVE_LABEL, orientedSize(iphone, false))).toBe(
      "iPhone 14 · 390×844",
    );
  });

  it("shows the rotated dimensions once the preset is landscape", () => {
    const iphone = preset("iphone-14");

    expect(formatDevicePresetLabel(iphone, RESPONSIVE_LABEL, orientedSize(iphone, true))).toBe(
      "iPhone 14 · 844×390",
    );
  });

  it("uses the translated name for responsive, which has no dimensions to show", () => {
    expect(formatDevicePresetLabel(preset("responsive"), "Adaptable", null)).toBe("Adaptable");
  });
});

describe("DEVICE_SIZE_PRESETS", () => {
  it("gives every preset a distinct id", () => {
    const ids = DEVICE_SIZE_PRESETS.map((candidate) => candidate.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sizes every preset except responsive", () => {
    const unsized = DEVICE_SIZE_PRESETS.filter((candidate) => candidate.width === null);

    expect(unsized.map((candidate) => candidate.id)).toEqual(["responsive"]);
  });
});
