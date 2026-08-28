import { describe, expect, it } from "vitest";
import {
  DEVICE_SIZE_PRESETS,
  formatDevicePresetLabel,
  orientedSize,
  type DeviceSizeId,
} from "./device-sizes";

const preset = (id: DeviceSizeId) => {
  const result = DEVICE_SIZE_PRESETS.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing preset: ${id}`);
  return result;
};

describe("device sizes", () => {
  it.each([
    ["iphone-14", false, { width: 390, height: 844 }],
    ["iphone-14", true, { width: 844, height: 390 }],
    ["laptop", true, { width: 1366, height: 768 }],
    ["laptop", false, { width: 768, height: 1366 }],
    ["responsive", false, null],
  ] as const)("orients %s with landscape=%s", (id, landscape, expected) => {
    expect(orientedSize(preset(id), landscape)).toEqual(expected);
  });

  it.each([
    ["iphone-14", "Responsive", false, "iPhone 14 · 390×844"],
    ["responsive", "Adaptable", false, "Adaptable"],
  ] as const)("formats %s", (id, label, landscape, expected) => {
    const device = preset(id);
    expect(formatDevicePresetLabel(device, label, orientedSize(device, landscape))).toBe(expected);
  });
});
