export interface TerminalGlyphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalRectGlyph {
  kind: "rects";
  rects: readonly TerminalGlyphRect[];
}

export interface TerminalPathGlyph {
  kind: "path";
  path: string;
  strokeWidth: number;
}

export type TerminalCustomGlyph = TerminalRectGlyph | TerminalPathGlyph;

const LIGHT_BOX_GLYPHS: Readonly<Record<string, TerminalPathGlyph>> = {
  "─": path("M0,.5 L1,.5"),
  "│": path("M.5,0 L.5,1"),
  "┌": path("M.5,1 L.5,.5 L1,.5"),
  "┐": path("M0,.5 L.5,.5 L.5,1"),
  "└": path("M.5,0 L.5,.5 L1,.5"),
  "┘": path("M0,.5 L.5,.5 L.5,0"),
  "├": path("M.5,0 L.5,1 M.5,.5 L1,.5"),
  "┤": path("M.5,0 L.5,1 M.5,.5 L0,.5"),
  "┬": path("M0,.5 L1,.5 M.5,.5 L.5,1"),
  "┴": path("M0,.5 L1,.5 M.5,.5 L.5,0"),
  "┼": path("M0,.5 L1,.5 M.5,0 L.5,1"),
  "╭": path("M.5,1 L.5,.75 Q.5,.5 .75,.5 L1,.5"),
  "╮": path("M0,.5 L.25,.5 Q.5,.5 .5,.75 L.5,1"),
  "╰": path("M.5,0 L.5,.25 Q.5,.5 .75,.5 L1,.5"),
  "╯": path("M0,.5 L.25,.5 Q.5,.5 .5,.25 L.5,0"),
};

const HEAVY_BOX_GLYPHS: Readonly<Record<string, TerminalPathGlyph>> = {
  "━": path("M0,.5 L1,.5", 3),
  "┃": path("M.5,0 L.5,1", 3),
  "┏": path("M.5,1 L.5,.5 L1,.5", 3),
  "┓": path("M0,.5 L.5,.5 L.5,1", 3),
  "┗": path("M.5,0 L.5,.5 L1,.5", 3),
  "┛": path("M0,.5 L.5,.5 L.5,0", 3),
  "┣": path("M.5,0 L.5,1 M.5,.5 L1,.5", 3),
  "┫": path("M.5,0 L.5,1 M.5,.5 L0,.5", 3),
  "┳": path("M0,.5 L1,.5 M.5,.5 L.5,1", 3),
  "┻": path("M0,.5 L1,.5 M.5,.5 L.5,0", 3),
  "╋": path("M0,.5 L1,.5 M.5,0 L.5,1", 3),
};

const BLOCK_GLYPHS: Readonly<Record<string, TerminalRectGlyph>> = {
  "▀": rects(rect(0, 0, 1, 0.5)),
  "▁": rects(rect(0, 0.875, 1, 0.125)),
  "▂": rects(rect(0, 0.75, 1, 0.25)),
  "▃": rects(rect(0, 0.625, 1, 0.375)),
  "▄": rects(rect(0, 0.5, 1, 0.5)),
  "▅": rects(rect(0, 0.375, 1, 0.625)),
  "▆": rects(rect(0, 0.25, 1, 0.75)),
  "▇": rects(rect(0, 0.125, 1, 0.875)),
  "█": rects(rect(0, 0, 1, 1)),
  "▉": rects(rect(0, 0, 0.875, 1)),
  "▊": rects(rect(0, 0, 0.75, 1)),
  "▋": rects(rect(0, 0, 0.625, 1)),
  "▌": rects(rect(0, 0, 0.5, 1)),
  "▍": rects(rect(0, 0, 0.375, 1)),
  "▎": rects(rect(0, 0, 0.25, 1)),
  "▏": rects(rect(0, 0, 0.125, 1)),
  "▐": rects(rect(0.5, 0, 0.5, 1)),
  "▔": rects(rect(0, 0, 1, 0.125)),
  "▕": rects(rect(0.875, 0, 0.125, 1)),
  "▖": rects(lowerLeft()),
  "▗": rects(lowerRight()),
  "▘": rects(upperLeft()),
  "▙": rects(upperLeft(), lowerLeft(), lowerRight()),
  "▚": rects(upperLeft(), lowerRight()),
  "▛": rects(upperLeft(), upperRight(), lowerLeft()),
  "▜": rects(upperLeft(), upperRight(), lowerRight()),
  "▝": rects(upperRight()),
  "▞": rects(upperRight(), lowerLeft()),
  "▟": rects(upperRight(), lowerLeft(), lowerRight()),
};

export function resolveTerminalCustomGlyph(char: string): TerminalCustomGlyph | null {
  return LIGHT_BOX_GLYPHS[char] ?? HEAVY_BOX_GLYPHS[char] ?? BLOCK_GLYPHS[char] ?? null;
}

export function isTerminalCustomGlyph(char: string): boolean {
  return resolveTerminalCustomGlyph(char) !== null;
}

function path(pathData: string, strokeWidth = 1): TerminalPathGlyph {
  return { kind: "path", path: pathData, strokeWidth };
}

function rect(x: number, y: number, width: number, height: number): TerminalGlyphRect {
  return { x, y, width, height };
}

function rects(...values: TerminalGlyphRect[]): TerminalRectGlyph {
  return { kind: "rects", rects: values };
}

function upperLeft(): TerminalGlyphRect {
  return rect(0, 0, 0.5, 0.5);
}

function upperRight(): TerminalGlyphRect {
  return rect(0.5, 0, 0.5, 0.5);
}

function lowerLeft(): TerminalGlyphRect {
  return rect(0, 0.5, 0.5, 0.5);
}

function lowerRight(): TerminalGlyphRect {
  return rect(0.5, 0.5, 0.5, 0.5);
}
