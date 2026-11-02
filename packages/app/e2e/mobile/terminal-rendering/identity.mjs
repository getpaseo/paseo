import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { checkTerminalScreenshot } from "./check.mjs";

// Checks that every printed cluster of a `render.mjs` run is the right glyph. `check.mjs` proves
// where ink lands and what color it has; this compares each cluster's ink with pango's (HarfBuzz)
// rendering of the same characters in the device's own fonts, so a wrong glyph, tofu, a solid
// block, a split conjunct or a cluster from elsewhere fails.
//
//   FONTCONFIG_FILE=<fonts.conf> node e2e/mobile/terminal-rendering/identity.mjs <run dir> [control]
//
// The fonts.conf lists the device's font files and prefers, for `monospace`, the terminal font
// followed by the device's fallbacks; `docs/terminal-rendering.md` says how to build one. Needs
// `pango-view` on the PATH.
//
// control:
//   none  judge the screenshot (default); exits 1 when a cluster fails.
//   rect  first fill every judged cluster's box with white; exits 1 unless every cluster fails.
//   swap  judge each cluster against a different cluster of the corpus; exits 1 unless every
//         cluster fails.
// The two controls prove the oracle refuses ink that is present but wrong.

/** Coverage grid side used to compare shapes. */
const GRID = 16;
/** A pixel at or above this ink strength (0..1) is part of a glyph's bounding box. */
const INK = 0.25;
/** Lowest shape correlation a cluster may have with its own reference. */
const THRESHOLD = 0.6;
/** How much better another cluster may match before the cluster's own match stops counting. */
const MARGIN = 0.02;
/** Lines whose cells carry decorations or a custom-drawn ruler; they stay geometry-only. */
const SKIPPED_LINES = new Set(["ruler", "styles"]);
const ZWJ = "‍";

/**
 * The renderer draws box and block characters to fill the cell, so they are judged against their
 * Unicode definition. Shades come from the font, whose fallback differs between the device and
 * pango, so a shade is judged by how evenly and densely it inks its own bounding box. Fonts dither
 * differently: ░ ▒ ▓ measure 0.16, 0.31, 0.75 in Droid Sans Mono and 0.19, 0.50, 0.81 in Menlo. The
 * bands split between those, and do not overlap, so one shade never passes as another.
 */
const CELL_GLYPHS = {
  "─": { arms: "LR" },
  "│": { arms: "UD" },
  "┬": { arms: "LRD" },
  "┴": { arms: "LRU" },
  "╭": { arms: "DR" },
  "╮": { arms: "DL" },
  "╰": { arms: "UR" },
  "╯": { arms: "UL" },
  "▀": { fill: "top" },
  "▄": { fill: "bottom" },
  "▌": { fill: "left" },
  "▐": { fill: "right" },
  "░": { shade: [0.08, 0.25] },
  "▒": { shade: [0.25, 0.625] },
  "▓": { shade: [0.625, 0.9] },
};
/** A shade must ink each region of this grid over its bounding box within its band. */
const SHADE_GRID = 4;
/** Regions of the cell, as fractions [left, top, right, bottom], that a line to each edge crosses. */
const ARM_REGIONS = {
  U: [0.3, 0, 0.7, 0.2],
  D: [0.3, 0.8, 0.7, 1],
  L: [0, 0.3, 0.2, 0.7],
  R: [0.8, 0.3, 1, 0.7],
};
/** [filled, empty] halves of each half block. */
const HALVES = {
  top: [
    [0, 0, 1, 0.5],
    [0, 0.5, 1, 1],
  ],
  bottom: [
    [0, 0.5, 1, 1],
    [0, 0, 1, 0.5],
  ],
  left: [
    [0, 0, 0.5, 1],
    [0.5, 0, 1, 1],
  ],
  right: [
    [0.5, 0, 1, 1],
    [0, 0, 0.5, 1],
  ],
};

const [dirArg, control = "none"] = process.argv.slice(2);
if (!dirArg || !["none", "rect", "swap"].includes(control)) {
  throw new Error("Usage: identity.mjs <run dir> [none|rect|swap]");
}
const dir = resolve(dirArg);
const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
const png = PNG.sync.read(readFileSync(resolve(dir, "terminal.png")));
const rows = new Map(report.rows.map((row) => [row.index, row.rect]));
const { grid, slots } = await checkTerminalScreenshot({ png, size: report.size, rows });

const printed = slots.filter(
  (slot) => !SKIPPED_LINES.has(slot.line) && !slot.isCursor && slot.chars.trim() !== "",
);
/** The columns xterm gives each printed cluster. */
const columnsOf = new Map(printed.map((slot) => [slot.chars, slot.width]));

if (control === "rect") {
  for (const { box } of printed) {
    for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y += 1) {
      for (let x = Math.ceil(box.left); x < Math.floor(box.right); x += 1) {
        png.data.set([255, 255, 255, 255], (png.width * y + x) * 4);
      }
    }
  }
}

/** Ink strength 0..1 of each pixel in a box: the largest channel distance from the background. */
function screenshotInk(box) {
  const left = Math.ceil(box.left);
  const top = Math.ceil(box.top);
  const width = Math.floor(box.right) - left;
  const height = Math.floor(box.bottom) - top;
  const ink = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (png.width * (top + y) + left + x) * 4;
      let distance = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        distance = Math.max(
          distance,
          Math.abs(png.data[offset + channel] - grid.background[channel]),
        );
      }
      ink[y * width + x] = distance / 255;
    }
  }
  return { ink, width, height };
}

/** Ink of the slot's whole cells, scaled so the foreground color is 1. */
function cellInk(slot) {
  const left = Math.round(grid.left + slot.col * grid.cellWidth);
  const right = Math.round(grid.left + (slot.col + slot.width) * grid.cellWidth);
  const cells = screenshotInk({ left, right, top: slot.box.top, bottom: slot.box.bottom });
  const full =
    Math.max(...[0, 1, 2].map((c) => Math.abs(grid.foreground[c] - grid.background[c]))) / 255;
  for (let i = 0; i < cells.ink.length; i += 1) cells.ink[i] = Math.min(1, cells.ink[i] / full);
  return cells;
}

const scratch = mkdtempSync(resolve(tmpdir(), "terminal-identity-"));
/** pango-view sizes its image to the text's advance plus this margin on each side. */
const REFERENCE_MARGIN = 48;
function pangoInk(text) {
  const out = resolve(scratch, "reference.png");
  execFileSync("pango-view", [
    "--no-display",
    "--dpi=72",
    "--font=monospace 96px",
    `--text=${text}`,
    "--background=black",
    "--foreground=white",
    `--margin=${REFERENCE_MARGIN}`,
    "-o",
    out,
  ]);
  const image = PNG.sync.read(readFileSync(out));
  const ink = new Float32Array(image.width * image.height);
  for (let i = 0; i < ink.length; i += 1) {
    const o = i * 4;
    ink[i] = Math.max(image.data[o], image.data[o + 1], image.data[o + 2]) / 255;
  }
  return {
    ink,
    width: image.width,
    height: image.height,
    advance: image.width - 2 * REFERENCE_MARGIN,
  };
}

/** The terminal font's cell advance at the reference size. */
const referenceCell = pangoInk("M").advance;

/**
 * The text as the renderer places it in `columns` cells: centred, scaled down when its advance is
 * wider, and cut at the cells' edges. Glyphs whose ink overhangs their advance, such as Devanagari
 * headlines, are cut on the device too.
 */
function referenceInk(text, columns) {
  const image = pangoInk(text);
  const box = Math.max(image.advance, columns * referenceCell);
  const left = Math.round(REFERENCE_MARGIN + (image.advance - box) / 2);
  const right = Math.round(REFERENCE_MARGIN + (image.advance + box) / 2);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (x < left || x >= right) image.ink[y * image.width + x] = 0;
    }
  }
  return image;
}

function regionInk({ ink, width, height }, [x0, y0, x1, y1]) {
  let [sum, max, count] = [0, 0, 0];
  for (let y = Math.floor(y0 * height); y < Math.ceil(y1 * height); y += 1) {
    for (let x = Math.floor(x0 * width); x < Math.ceil(x1 * width); x += 1) {
      const value = ink[y * width + x] ?? 0;
      sum += value;
      max = Math.max(max, value);
      count += 1;
    }
  }
  return { mean: sum / count, max };
}

function inkBox({ ink, width, height }) {
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (ink[y * width + x] < INK) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Whether an unbroken line crosses the region to the cell edge: a row for L/R, a column for U/D. */
function lineCrosses({ ink, width, height }, arm) {
  const [x0, y0, x1, y1] = ARM_REGIONS[arm];
  const [left, top, right, bottom] = [
    Math.floor(x0 * width),
    Math.floor(y0 * height),
    Math.ceil(x1 * width),
    Math.ceil(y1 * height),
  ];
  const horizontal = arm === "L" || arm === "R";
  const [outerFrom, outerTo, innerFrom, innerTo] = horizontal
    ? [top, bottom, left, right]
    : [left, right, top, bottom];
  for (let outer = outerFrom; outer < outerTo; outer += 1) {
    let unbroken = true;
    for (let inner = innerFrom; inner < innerTo && unbroken; inner += 1) {
      const [x, y] = horizontal ? [inner, outer] : [outer, inner];
      unbroken = (ink[y * width + x] ?? 0) >= 0.5;
    }
    if (unbroken) return true;
  }
  return false;
}

/** 1 when the cell matches the character's definition, 0 otherwise. */
function cellGlyphScore(slot, spec) {
  const ink = cellInk(slot);
  if (spec.arms) {
    const matches = Object.keys(ARM_REGIONS).every((arm) =>
      spec.arms.includes(arm) ? lineCrosses(ink, arm) : regionInk(ink, ARM_REGIONS[arm]).max < 0.3,
    );
    return matches ? 1 : 0;
  }
  if (spec.fill) {
    const [filled, empty] = HALVES[spec.fill].map((region) => regionInk(ink, region).mean);
    return filled >= 0.8 && empty <= 0.2 ? 1 : 0;
  }
  const box = inkBox(ink);
  if (!box || box.width < 0.7 * ink.width || box.height < 0.5 * ink.height) return 0;
  const [x0, y0] = [box.x / ink.width, box.y / ink.height];
  const [x1, y1] = [(box.x + box.width) / ink.width, (box.y + box.height) / ink.height];
  const [w, h] = [(x1 - x0) / SHADE_GRID, (y1 - y0) / SHADE_GRID];
  const regions = Array.from({ length: SHADE_GRID * SHADE_GRID }, (_, index) => {
    const [gx, gy] = [index % SHADE_GRID, Math.floor(index / SHADE_GRID)];
    return [x0 + gx * w, y0 + gy * h, x0 + (gx + 1) * w, y0 + (gy + 1) * h];
  });
  const means = regions.map((region) => regionInk(ink, region).mean);
  return means.every((mean) => mean >= spec.shade[0] && mean < spec.shade[1]) ? 1 : 0;
}

/** Coverage of the ink's bounding box, centered in a square that keeps its aspect, at GRID². */
function coverage(image) {
  const box = inkBox(image);
  if (!box) return null;
  const side = Math.max(box.width, box.height);
  const originX = box.x - (side - box.width) / 2;
  const originY = box.y - (side - box.height) / 2;
  const vector = new Float32Array(GRID * GRID);
  const step = side / GRID;
  const samples = 4;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      let sum = 0;
      for (let sample = 0; sample < samples * samples; sample += 1) {
        const x = Math.floor(originX + (gx + ((sample % samples) + 0.5) / samples) * step);
        const y = Math.floor(
          originY + (gy + (Math.floor(sample / samples) + 0.5) / samples) * step,
        );
        sum +=
          x >= 0 && y >= 0 && x < image.width && y < image.height
            ? image.ink[y * image.width + x]
            : 0;
      }
      vector[gy * GRID + gx] = sum / (samples * samples);
    }
  }
  return vector;
}

/** Pearson correlation of two coverage vectors; -1 when either has no ink or no contrast. */
function correlation(a, b) {
  if (!a || !b) return -1;
  const n = a.length;
  let [ma, mb] = [0, 0];
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let [num, da, db] = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da === 0 || db === 0 ? -1 : num / Math.sqrt(da * db);
}

const references = new Map();
/**
 * The cluster alone and with a zero-width joiner before, after and on both sides, so any Arabic
 * positional form of the right letter matches.
 */
function referenceVectors(chars) {
  if (!references.has(chars)) {
    const forms = [chars, ZWJ + chars, chars + ZWJ, ZWJ + chars + ZWJ];
    references.set(
      chars,
      forms.map((text) => coverage(referenceInk(text, columnsOf.get(chars)))),
    );
  }
  return references.get(chars);
}

function shapeScore(vector, chars) {
  return Math.max(...referenceVectors(chars).map((reference) => correlation(vector, reference)));
}

/**
 * pango draws no ink for Apple Color Emoji, and draws flags on neither device. Those clusters have
 * no reference and are reported instead of judged.
 */
const hasReference = (chars) =>
  CELL_GLYPHS[chars] ||
  (!/^\p{Regional_Indicator}{2}$/u.test(chars) && referenceVectors(chars).some(Boolean));
const judged = printed.filter((slot) => hasReference(slot.chars));
const unjudged = printed
  .filter((slot) => !hasReference(slot.chars))
  .map((slot) => ({
    line: slot.line,
    col: slot.col,
    chars: slot.chars,
    reason: "no reference ink",
  }));

const distinct = [...new Set(judged.map((slot) => slot.chars))];
const shapes = distinct.filter((chars) => !CELL_GLYPHS[chars]);

/** The cluster a slot is judged against: its own, or under `swap` a different one. */
function expectedChars(slot, index) {
  if (control !== "swap") return slot.chars;
  const own = distinct.indexOf(slot.chars);
  const other = distinct[(own + 1 + (index % (distinct.length - 1))) % distinct.length];
  return other === slot.chars ? distinct[(own + 1) % distinct.length] : other;
}

function judge(slot, index) {
  const expected = expectedChars(slot, index);
  const result = { line: slot.line, row: slot.row, col: slot.col, chars: slot.chars, expected };
  const spec = CELL_GLYPHS[expected];
  if (spec) {
    result.score = cellGlyphScore(slot, spec);
    return result;
  }
  // The shape must also resemble its own cluster at least as much as any other cluster in the
  // corpus, within MARGIN, so a near-lookalike such as g judged as 8 fails.
  const vector = coverage(screenshotInk(slot.box));
  const score = shapeScore(vector, expected);
  let nearest = { chars: expected, score };
  for (const other of shapes) {
    if (other === expected) continue;
    const otherScore = shapeScore(vector, other);
    if (otherScore > nearest.score) nearest = { chars: other, score: otherScore };
  }
  const distinctive = nearest.chars === expected || nearest.score - score <= MARGIN;
  result.score = distinctive ? score : Math.min(score, 0);
  result.nearest = nearest;
  return result;
}

const results = judged.map(judge);
rmSync(scratch, { recursive: true, force: true });

const passed = results.filter((result) => result.score >= THRESHOLD);
const failed = results.filter((result) => result.score < THRESHOLD);
const outDir = resolve(dir, "identity");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, `${control}.json`),
  `${JSON.stringify({ control, threshold: THRESHOLD, unjudged, results }, null, 2)}\n`,
);

const format = (result) =>
  `${result.line}@${result.col}(${result.chars}${result.expected === result.chars ? "" : `→${result.expected}`})=${result.score.toFixed(2)}${result.nearest && result.nearest.chars !== result.expected ? ` nearest ${result.nearest.chars}` : ""}`;
console.log(
  `${report.label} ${control}: ${results.length} clusters judged, ${passed.length} pass, ${failed.length} fail, ${unjudged.length} unjudged (${outDir})`,
);
if (control === "none") {
  for (const result of failed) console.log(`  fail ${format(result)}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} else {
  for (const result of passed) console.log(`  accepted ${format(result)}`);
  process.exitCode = passed.length === 0 ? 0 : 1;
}
