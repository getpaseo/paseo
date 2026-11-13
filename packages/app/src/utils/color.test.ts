import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  desaturateHexColor,
  hexColorWithAlpha,
  mixHexColors,
  parseHexColor,
  stepContrast,
} from "./color";

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

describe("hexColorWithAlpha", () => {
  it("creates a cross-platform rgba color from an owned theme color", () => {
    expect(hexColorWithAlpha("#3e704a", 0.15)).toBe("rgba(62, 112, 74, 0.15)");
  });

  it("rejects colors and alpha values outside its contract", () => {
    expect(() => hexColorWithAlpha("currentColor", 0.15)).toThrow();
    expect(() => hexColorWithAlpha("#3e704a", 1.1)).toThrow();
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

describe("contrastRatio", () => {
  it("is 21 between black and white and 1 for the same color", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#3e704a", "#3e704a")).toBe(1);
  });
});

describe("stepContrast", () => {
  it("steps off pure black by a visible contrast, where a lightness delta would not", () => {
    const stepped = stepContrast("#000000", "#fafafa", 1.11);
    expect(stepped).not.toBe("#000000");
    expect(contrastRatio("#000000", stepped)).toBeCloseTo(1.11, 1);
  });

  it("moves toward the target, lighter or darker", () => {
    expect(stepContrast("#f4f4f5", "#1a1a1e", 1.35) < "#f4f4f5").toBe(true);
    expect(stepContrast("#181b1a", "#fafafa", 1.245) > "#181b1a").toBe(true);
  });

  it("stops at the target when the ratio is out of reach", () => {
    expect(stepContrast("#808080", "#909090", 21)).toBe("#909090");
  });
});

describe("colours with an alpha channel", () => {
  it("are compared and stepped as the opaque colour", () => {
    expect(contrastRatio("#1e1e2eff", "#ffffff")).toBe(contrastRatio("#1e1e2e", "#ffffff"));
    expect(contrastRatio("#fffe", "#000")).toBeCloseTo(21, 5);
    expect(stepContrast("#1e1e2e80", "#cdd6f4", 1.8)).toBe(stepContrast("#1e1e2e", "#cdd6f4", 1.8));
  });
});

describe("mixHexColors", () => {
  it("blends by the given fraction", () => {
    expect(mixHexColors("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHexColors("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHexColors("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});
