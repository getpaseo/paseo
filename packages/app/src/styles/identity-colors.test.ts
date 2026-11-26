import { describe, expect, it } from "vitest";
import {
  IDENTITY_COLOR_NAMES,
  deriveProjectColors,
  deriveIdentityColorName,
  identityColor,
} from "@/styles/identity-colors";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(
      (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255,
    );
    const linear = channels.map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("identity colors", () => {
  it("keeps ten colors so existing derived assignments stay put", () => {
    expect(IDENTITY_COLOR_NAMES.length).toBe(10);
  });

  it("derives the same color a project key had before the palette moved", () => {
    expect(identityColor(deriveIdentityColorName("paseo"))).toBe("#368080");
    expect(identityColor(deriveIdentityColorName("my-project"))).toBe("#7a6aa8");
    expect(identityColor(deriveIdentityColorName("a"))).toBe("#b06260");
  });

  it("keeps every fill in the white-letter contrast band", () => {
    for (const color of IDENTITY_COLOR_NAMES) {
      expect(contrastRatio(identityColor(color), "#ffffff")).toBeGreaterThanOrEqual(4.2);
      expect(contrastRatio(identityColor(color), "#ffffff")).toBeLessThanOrEqual(4.8);
    }
  });
});

describe("project colors", () => {
  it("keeps project initials legible across the seven-color rainbow", () => {
    const colors = Array.from({ length: 100 }, (_, index) =>
      deriveProjectColors(`project-${index}`, index),
    );
    expect(colors.slice(0, 8).map((entry) => entry.backgroundColor)).toEqual([
      "#BE6C6B",
      "#CA925A",
      "#D5BD75",
      "#6F9C79",
      "#60A3AE",
      "#628AB9",
      "#947BB5",
      "#BE6C6B",
    ]);
    expect(new Set(colors.map((entry) => entry.backgroundColor)).size).toBe(7);
    for (const entry of colors) {
      expect(contrastRatio(entry.color, entry.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
