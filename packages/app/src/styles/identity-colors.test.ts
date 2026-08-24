import { describe, expect, it } from "vitest";
import {
  IDENTITY_COLOR_NAMES,
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
