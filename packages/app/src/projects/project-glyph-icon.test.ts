import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import {
  crc32,
  decodeGlyphTag,
  findProjectGlyph,
  glyphTileSvg,
  insertPngText,
  listProjectGlyphs,
  readPngText,
  readProjectGlyphChoice,
  searchProjectGlyphs,
  tagGlyphPng,
} from "./project-glyph-icon";
import { RADIX_GLYPHS } from "./radix-glyphs";

// A 1×1 transparent PNG, as a canvas would hand it back.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("project glyph icons", () => {
  it("offers every Radix glyph once, project-like glyphs first", () => {
    const names = listProjectGlyphs().map((glyph) => glyph.name);

    expect(names).toHaveLength(RADIX_GLYPHS.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(0, 3)).toEqual(["rocket", "code", "cube"]);
  });

  it("matches every word of a search, with or without separators", () => {
    expect(searchProjectGlyphs("arrow left").map((glyph) => glyph.name)).toContain("arrow-left");
    expect(searchProjectGlyphs("githublogo").map((glyph) => glyph.name)).toEqual(["github-logo"]);
    expect(searchProjectGlyphs("  ")).toHaveLength(RADIX_GLYPHS.length);
    expect(searchProjectGlyphs("no-such-glyph")).toEqual([]);
  });

  it("composes a rounded tile with the glyph centered in white", () => {
    const rocket = findProjectGlyph("rocket");
    if (!rocket) throw new Error("rocket glyph missing");

    const svg = glyphTileSvg(rocket, "#3d7ea6", 256);

    expect(svg).toContain('<rect width="256" height="256" rx="64" fill="#3d7ea6"/>');
    expect(svg).toContain('transform="translate(56 56) scale(9.6)" fill="#ffffff"');
    expect(svg).toContain(rocket.body);
  });

  it("computes the PNG CRC-32", () => {
    expect(crc32(new Uint8Array(Buffer.from("IEND")))).toBe(0xae426082);
  });

  it("adds a text chunk a PNG reader can find again, before IEND", () => {
    const tagged = insertPngText(new Uint8Array(ONE_PIXEL_PNG), "paseo-glyph", "rocket #3d7ea6");

    expect(readPngText(tagged, "paseo-glyph")).toBe("rocket #3d7ea6");
    expect(Buffer.from(tagged.subarray(tagged.length - 8, tagged.length - 4)).toString()).toBe(
      "IEND",
    );
    expect(readPngText(new Uint8Array(ONE_PIXEL_PNG), "paseo-glyph")).toBeNull();
  });

  it("reads the glyph back from an icon made by the picker, and nothing from other images", () => {
    const tagged = tagGlyphPng(new Uint8Array(ONE_PIXEL_PNG), { name: "rocket", color: "#3D7EA6" });
    const dataUri = `data:image/png;base64,${Buffer.from(tagged).toString("base64")}`;

    expect(readProjectGlyphChoice(dataUri)).toEqual({ name: "rocket", color: "#3d7ea6" });
    expect(
      readProjectGlyphChoice(`data:image/png;base64,${ONE_PIXEL_PNG.toString("base64")}`),
    ).toBeNull();
    expect(readProjectGlyphChoice("data:image/svg+xml;base64,PHN2Zy8+")).toBeNull();
    expect(readProjectGlyphChoice(null)).toBeNull();
  });

  it("ignores tags naming an unknown glyph or a malformed color", () => {
    expect(decodeGlyphTag("not-a-glyph #3d7ea6")).toBeNull();
    expect(decodeGlyphTag("rocket red")).toBeNull();
    expect(decodeGlyphTag("rocket #3d7ea6")).toEqual({ name: "rocket", color: "#3d7ea6" });
  });
});
