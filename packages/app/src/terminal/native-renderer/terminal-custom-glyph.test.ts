import { describe, expect, it } from "vitest";

import { resolveTerminalCustomGlyph } from "./terminal-custom-glyph";

describe("native terminal custom glyphs", () => {
  it("fills the complete cell for the full block used by the Claude mascot", () => {
    expect(resolveTerminalCustomGlyph("█")).toEqual({
      kind: "rects",
      rects: [{ x: 0, y: 0, width: 1, height: 1 }],
    });
  });

  it("draws every Claude mascot block from exact cell fractions", () => {
    const mascot = ["▐▛███▜▌", "▝▜█████▛▘", "▘▘ ▝▝"];
    const customGlyphs = mascot
      .join("")
      .replaceAll(" ", "")
      .split("")
      .map(resolveTerminalCustomGlyph);

    expect(customGlyphs).not.toContain(null);
    expect(resolveTerminalCustomGlyph("▐")).toEqual({
      kind: "rects",
      rects: [{ x: 0.5, y: 0, width: 0.5, height: 1 }],
    });
    expect(resolveTerminalCustomGlyph("▛")).toEqual({
      kind: "rects",
      rects: [
        { x: 0, y: 0, width: 0.5, height: 0.5 },
        { x: 0.5, y: 0, width: 0.5, height: 0.5 },
        { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      ],
    });
    expect(resolveTerminalCustomGlyph("▝")).toEqual({
      kind: "rects",
      rects: [{ x: 0.5, y: 0, width: 0.5, height: 0.5 }],
    });
  });

  it("connects the rounded Claude welcome frame to every cell edge", () => {
    expect(resolveTerminalCustomGlyph("─")).toEqual({
      kind: "path",
      path: "M0,.5 L1,.5",
      strokeWidth: 1,
    });
    expect(resolveTerminalCustomGlyph("│")).toEqual({
      kind: "path",
      path: "M.5,0 L.5,1",
      strokeWidth: 1,
    });
    expect(resolveTerminalCustomGlyph("╭")).toEqual({
      kind: "path",
      path: "M.5,1 L.5,.75 Q.5,.5 .75,.5 L1,.5",
      strokeWidth: 1,
    });
    expect(resolveTerminalCustomGlyph("╮")).toEqual({
      kind: "path",
      path: "M0,.5 L.25,.5 Q.5,.5 .5,.75 L.5,1",
      strokeWidth: 1,
    });
    expect(resolveTerminalCustomGlyph("╰")).toEqual({
      kind: "path",
      path: "M.5,0 L.5,.25 Q.5,.5 .75,.5 L1,.5",
      strokeWidth: 1,
    });
    expect(resolveTerminalCustomGlyph("╯")).toEqual({
      kind: "path",
      path: "M0,.5 L.25,.5 Q.5,.5 .5,.25 L.5,0",
      strokeWidth: 1,
    });
  });

  it("keeps ordinary terminal text on the font renderer", () => {
    expect(resolveTerminalCustomGlyph("C")).toBeNull();
    expect(resolveTerminalCustomGlyph(" ")).toBeNull();
  });

  it("covers common light and heavy terminal ASCII-art frames", () => {
    const frames = [
      "┌────┬────┐│    │    │├────┼────┤└────┴────┘",
      "┏━━━━┳━━━━┓┃    ┃    ┃┣━━━━╋━━━━┫┗━━━━┻━━━━┛",
    ];

    for (const char of frames.join("").replaceAll(" ", "")) {
      expect(resolveTerminalCustomGlyph(char), `missing custom glyph ${char}`).not.toBeNull();
    }
  });
});
