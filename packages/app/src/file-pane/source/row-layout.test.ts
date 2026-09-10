import { describe, expect, it } from "vitest";
import { sourceRowOffsets, visualLineCount } from "./row-layout";

// Measured on a Pixel-class Android device at the default code size: one visual line is 17.5234dp
// after the device rounds it, and 49 monospace characters fit beside the gutter.
const VISUAL_LINE_HEIGHT = 17.5234375;
const COLUMNS = 49;

// An ordinary TypeScript line, 119 characters, of the kind that fills a real source file.
const ORDINARY_LINE =
  "export function handlerNumber1(input: Record<string, unknown>, options: { retries: number }): Promise<void> { /* 1 */ }";

describe("visualLineCount", () => {
  it("keeps a line that fits on one visual line", () => {
    expect(visualLineCount("const a = 1;", COLUMNS)).toBe(1);
    expect(visualLineCount("", COLUMNS)).toBe(1);
  });

  it("counts the visual lines an ordinary source line occupies", () => {
    expect(visualLineCount(ORDINARY_LINE, COLUMNS)).toBe(3);
  });

  it("breaks early at a space, where dividing by the column count would not", () => {
    // A larger code size narrows the columns. Character division says four lines; the platform
    // cannot split "handlerNumber1(input:" across a space that is not there, so it needs five.
    expect(Math.ceil(ORDINARY_LINE.length / 33)).toBe(4);
    expect(visualLineCount(ORDINARY_LINE, 33)).toBe(5);
  });

  it("breaks a single word that is wider than the line", () => {
    expect(visualLineCount("x".repeat(COLUMNS * 3), COLUMNS)).toBe(3);
  });

  it("assumes one visual line until the column width is measured", () => {
    expect(visualLineCount(ORDINARY_LINE, 0)).toBe(1);
  });
});

describe("sourceRowOffsets", () => {
  it("stacks rows by the visual lines they really occupy", () => {
    const offsets = sourceRowOffsets([{ text: "const a = 1;" }, { text: ORDINARY_LINE }], {
      columns: COLUMNS,
      visualLineHeight: VISUAL_LINE_HEIGHT,
    });
    expect(Array.from(offsets)).toEqual([0, VISUAL_LINE_HEIGHT, VISUAL_LINE_HEIGHT * 4]);
  });

  it("puts a match after a thousand ordinary lines where it is really drawn", () => {
    // The regression: 1,200 ordinary lines, match on 1,201. Claiming one visual line per row
    // reported 1200 * 17.52 = 21,028, which is about line 1,100 on screen — the match was roughly
    // 90 lines below the fold and never revealed.
    const lines = [
      ...Array.from({ length: 1200 }, () => ({ text: ORDINARY_LINE })),
      { text: 'const target = "needle";' },
    ];
    const offsets = sourceRowOffsets(lines, {
      columns: COLUMNS,
      visualLineHeight: VISUAL_LINE_HEIGHT,
    });
    expect(offsets[1200]).toBeCloseTo(1200 * 3 * VISUAL_LINE_HEIGHT, 5);
    expect(offsets[1200]).toBeGreaterThan(1200 * VISUAL_LINE_HEIGHT * 2.9);
  });
});
