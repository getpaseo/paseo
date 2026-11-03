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

/**
 * One custom glyph as the native view consumes it. Coordinates are fractions of one cell.
 * `rects` is flattened `[x, y, width, height]`. `path` is flattened commands:
 * `0 x y` moves, `1 x y` draws a line, `2 cx cy x y` draws a quadratic curve. Paths are
 * stroked with `strokeWidth` points regardless of cell size.
 */
export interface PaseoTerminalCustomGlyph {
  char: string;
  rects: number[];
  path: number[];
  strokeWidth: number;
}

const PATH_COMMAND_CODES: Readonly<Record<string, { code: number; coordinates: number }>> = {
  M: { code: 0, coordinates: 2 },
  L: { code: 1, coordinates: 2 },
  Q: { code: 2, coordinates: 4 },
};

export function resolveTerminalCustomGlyph(char: string): TerminalCustomGlyph | null {
  return LIGHT_BOX_GLYPHS[char] ?? HEAVY_BOX_GLYPHS[char] ?? BLOCK_GLYPHS[char] ?? null;
}

export function encodeTerminalCustomGlyphs(): PaseoTerminalCustomGlyph[] {
  const table = { ...LIGHT_BOX_GLYPHS, ...HEAVY_BOX_GLYPHS, ...BLOCK_GLYPHS };
  return Object.entries(table).map(([char, glyph]) =>
    glyph.kind === "rects"
      ? {
          char,
          rects: glyph.rects.flatMap((value) => [value.x, value.y, value.width, value.height]),
          path: [],
          strokeWidth: 0,
        }
      : { char, rects: [], path: encodePath(glyph.path), strokeWidth: glyph.strokeWidth },
  );
}

function encodePath(pathData: string): number[] {
  const tokens = pathData.match(/[MLQ]|-?\d*\.?\d+/g) ?? [];
  const encoded: number[] = [];
  let index = 0;
  while (index < tokens.length) {
    const command = PATH_COMMAND_CODES[tokens[index]];
    if (!command) {
      throw new Error(`Unsupported terminal glyph path command in ${pathData}`);
    }
    const coordinates = tokens.slice(index + 1, index + 1 + command.coordinates).map(Number);
    if (coordinates.length !== command.coordinates || coordinates.some(Number.isNaN)) {
      throw new Error(`Malformed terminal glyph path ${pathData}`);
    }
    encoded.push(command.code, ...coordinates);
    index += 1 + command.coordinates;
  }
  return encoded;
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
