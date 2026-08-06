import { describe, expect, it } from "vitest";
import { desaturateHexColor, parseHexColor } from "./color";

describe("parseHexColor", () => {
  it("parses six-digit hex", () => {
    expect(parseHexColor("#ff8000")).toEqual([1, 128 / 255, 0]);
  });

  it("expands three-digit hex", () => {
    expect(parseHexColor("#f80")).toEqual(parseHexColor("#ff8800"));
  });

  it("rejects anything else", () => {
    expect(parseHexColor("none")).toBeNull();
    expect(parseHexColor("url(#a)")).toBeNull();
    expect(parseHexColor("#ff800")).toBeNull();
  });
});

describe("desaturateHexColor", () => {
  it("leaves a colour alone at full chroma", () => {
    expect(desaturateHexColor("#0288d1", 1)).toBe("#0288d1");
  });

  it("returns grey at zero chroma", () => {
    const grey = desaturateHexColor("#0288d1", 0);
    const rgb = parseHexColor(grey);
    expect(rgb).not.toBeNull();
    const [r, g, b] = rgb as [number, number, number];
    expect(Math.abs(r - g)).toBeLessThan(0.01);
    expect(Math.abs(g - b)).toBeLessThan(0.01);
  });

  it("drops chroma monotonically", () => {
    const spread = (hex: string) => {
      const [r, g, b] = parseHexColor(hex) as [number, number, number];
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    for (const source of ["#ffca28", "#0288d1", "#f44336", "#7e57c2"]) {
      const steps = [1, 0.75, 0.5, 0.25, 0].map((amount) =>
        spread(desaturateHexColor(source, amount)),
      );
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]).toBeLessThan(steps[i - 1]);
      }
    }
  });

  // Pinned so a typo in the OKLab matrices shows up as a diff rather than as icons that look
  // slightly off. The interesting one is the yellow: its green channel goes *up* and its blue
  // rises to meet it, which is what holding lightness instead of scaling HSL saturation buys.
  it("matches known values", () => {
    expect(desaturateHexColor("#0288d1", 0.65)).toBe("#4a87b6");
    expect(desaturateHexColor("#ffca28", 0.65)).toBe("#efce7b");
    expect(desaturateHexColor("#f44336", 0.65)).toBe("#d4685a");
  });

  it("passes non-hex input through untouched", () => {
    expect(desaturateHexColor("none", 0.5)).toBe("none");
    expect(desaturateHexColor("currentColor", 0.5)).toBe("currentColor");
  });
});
