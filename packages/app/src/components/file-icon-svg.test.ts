import { describe, expect, it } from "vitest";
import { getFileIconSvg } from "./file-icon-svg";
import { getRawFileIconSvg } from "./material-file-icons";

function hexColors(svg: string): string[] {
  return svg.match(/#[0-9a-fA-F]{6}/g) ?? [];
}

/** How far a colour is from grey, measured crudely enough not to re-derive the implementation. */
function channelSpread(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return Math.max(r, g, b) - Math.min(r, g, b);
}

describe("getFileIconSvg", () => {
  it("keeps the vendor geometry and only rewrites colours", () => {
    const raw = getRawFileIconSvg("index.ts");
    const toned = getFileIconSvg("index.ts");
    expect(toned).not.toBe(raw);
    expect(toned.replace(/#[0-9a-fA-F]{6}/g, "#")).toBe(raw.replace(/#[0-9a-fA-F]{6}/g, "#"));
  });

  it("pulls every colour toward neutral", () => {
    const spread = (svg: string) => hexColors(svg).map(channelSpread);

    for (const file of ["main.ts", "app.jsx", "style.css", "data.json", "notes.md"]) {
      const before = spread(getRawFileIconSvg(file));
      const after = spread(getFileIconSvg(file));
      expect(after).toHaveLength(before.length);
      after.forEach((value, index) => expect(value).toBeLessThan(before[index]));
    }
  });

  it("leaves non-colour attributes alone", () => {
    const toned = getFileIconSvg("Main.kt");
    expect(toned).toContain('fill="url(#a)"');
  });

  it("returns the same string for repeated lookups", () => {
    expect(getFileIconSvg("a.ts")).toBe(getFileIconSvg("b.ts"));
  });

  it("falls back to the default icon for unknown extensions", () => {
    expect(getFileIconSvg("thing.qqq")).toBe(getFileIconSvg("thing"));
  });
});
