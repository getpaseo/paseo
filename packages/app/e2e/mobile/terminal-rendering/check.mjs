import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { PNG } from "pngjs";
import { ACCENT, fixtureLines, fixtureOutput, RULER_CELLS, SELECT_LINE } from "./fixture.mjs";

/** A pixel is ink when one channel differs from the terminal background by more than this. */
const INK_THRESHOLD = 70;
/** Ink pixels a printed grapheme cluster needs inside its own columns. */
const MIN_CLUSTER_INK = 3;
/** How far a pixel may sit from the background-to-color blend line and still count as that color. */
const BLEND_TOLERANCE = 40;
/** Pixels of another cell's color tolerated in a cell, for antialiasing at the cell edge. */
const MAX_FOREIGN_INK = 2;

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

/**
 * Checks a screenshot of the fixture against the cells xterm assigns: every printed grapheme
 * cluster has ink inside its own columns, blank cells stay blank, and the cursor sits right after
 * the text. A cluster that spans cells, such as a Devanagari conjunct, is shaped as one unit, so
 * it is judged across all its columns. On rows that use the fixture's accent color, every cell
 * must be drawn in its own color, including cells that share a shaped cluster.
 *
 * These are geometry and color checks: they cannot tell a correct glyph from a wrong one.
 *
 * `rows` maps a terminal row index to its rect in screenshot pixels.
 */
export async function checkTerminalScreenshot({ png, size, rows }) {
  const terminal = await fixtureTerminal(size);
  assert.ok(rows.get(0), "The ruler row is not exposed as terminal-row-0");
  const grid = measureGrid(png, rows.get(0));
  const { failures, slots } = checkRows({ png, terminal, rows, grid });
  terminal.dispose();
  return { grid, failures, slots };
}

/** Where the harness selects: the first cell of the conjunct that starts the `select` line. */
export async function selectionTarget({ size }) {
  const terminal = await fixtureTerminal(size);
  const row = lineNames(terminal.buffer.active, terminal.buffer.active.cursorY + 1).indexOf(
    SELECT_LINE,
  );
  terminal.dispose();
  return { row, col: 0, clusterColumns: 2 };
}

/**
 * Checks a screenshot taken with only the first cell of the `select` conjunct selected: that cell
 * has the selection background and the conjunct's second, unselected cell keeps its accent color.
 */
export function checkPartialSelection({ png, rows, grid, target }) {
  const rect = rows.get(target.row);
  if (!rect) return [{ row: target.row, kind: "missing-row" }];
  const cell = (col) => ({
    left: grid.left + col * grid.cellWidth + 1,
    right: grid.left + (col + 1) * grid.cellWidth - 1,
    top: rect.y,
    bottom: rect.y + rect.height,
  });
  const selected = cell(target.col);
  const unselected = cell(target.col + 1);
  const selectionBackground = pixelAt(png, selected.left + 1, selected.top + 1);
  const unselectedBackground = pixelAt(png, unselected.left + 1, unselected.top + 1);
  if (
    !differs(selectionBackground, grid.background) ||
    differs(unselectedBackground, grid.background)
  ) {
    return [{ row: target.row, col: target.col, kind: "selection-not-set-up" }];
  }
  const failures = [];
  const ownInk = countColor(png, unselected, grid.background, ACCENT);
  if (ownInk < MIN_CLUSTER_INK) {
    failures.push({ row: target.row, col: target.col + 1, kind: "unselected-cell-lost-color" });
  }
  return failures;
}

async function fixtureTerminal(size) {
  const terminal = new xterm.Terminal({
    cols: size.columns,
    rows: size.rows,
    allowProposedApi: true,
  });
  await new Promise((done) =>
    terminal.write(fixtureOutput(size.columns).replaceAll("\n", "\r\n"), done),
  );
  return terminal;
}

export function writeOverlay(png, slots, path) {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  for (const slot of slots) {
    const color = slot.ok ? [0, 200, 0] : [255, 0, 0];
    const { left, right, top, bottom } = slot.box;
    for (let x = Math.ceil(left); x < right; x += 1) {
      for (const y of [Math.ceil(top), Math.floor(bottom) - 1]) {
        const offset = (out.width * y + x) * 4;
        out.data.set(color, offset);
      }
    }
    if (!slot.ok) {
      for (let y = Math.ceil(top); y < bottom; y += 1) {
        for (const x of [Math.ceil(left), Math.floor(right) - 1]) {
          out.data.set(color, (out.width * y + x) * 4);
        }
      }
    }
  }
  writeFileSync(path, PNG.sync.write(out));
}

function inkAt(png, x, y, background) {
  const offset = (png.width * Math.round(y) + Math.round(x)) * 4;
  return (
    Math.abs(png.data[offset] - background[0]) > INK_THRESHOLD ||
    Math.abs(png.data[offset + 1] - background[1]) > INK_THRESHOLD ||
    Math.abs(png.data[offset + 2] - background[2]) > INK_THRESHOLD
  );
}

/** Pixels in `box` that differ from `background` in some channel by more than the ink threshold. */
export function countInk(png, box, background) {
  let count = 0;
  for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y += 1) {
    for (let x = Math.ceil(box.left); x < Math.floor(box.right); x += 1) {
      if (inkAt(png, x, y, background)) count += 1;
    }
  }
  return count;
}

function differs(a, b) {
  return a.some((channel, index) => Math.abs(channel - b[index]) > INK_THRESHOLD);
}

/** Distance from `pixel` to the nearest blend of `background` toward `color`. */
function blendDistance(pixel, background, color) {
  const direction = color.map((channel, index) => channel - background[index]);
  const length = direction.reduce((sum, value) => sum + value * value, 0);
  const offset = pixel.map((channel, index) => channel - background[index]);
  const along = offset.reduce((sum, value, index) => sum + value * direction[index], 0);
  const alpha = length === 0 ? 0 : Math.min(1, Math.max(0, along / length));
  return Math.hypot(...offset.map((value, index) => value - alpha * direction[index]));
}

/** Ink pixels in `box` that are a blend of the background toward `color`. */
function countColor(png, box, background, color, other) {
  let count = 0;
  for (let y = Math.ceil(box.top); y < Math.floor(box.bottom); y += 1) {
    for (let x = Math.ceil(box.left); x < Math.floor(box.right); x += 1) {
      if (!inkAt(png, x, y, background)) continue;
      const pixel = pixelAt(png, x, y);
      const distance = blendDistance(pixel, background, color);
      if (distance > BLEND_TOLERANCE) continue;
      if (other && blendDistance(pixel, background, other) <= distance) continue;
      count += 1;
    }
  }
  return count;
}

function pixelAt(png, x, y) {
  const offset = (png.width * Math.round(y) + Math.round(x)) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

/** Reads the grid origin and cell width from a ruler row of `RULER_CELLS` full blocks. */
export function measureGrid(png, rulerRect) {
  const y = rulerRect.y + rulerRect.height / 2;
  const background = pixelAt(png, rulerRect.x + rulerRect.width - 2, y);
  let left = -1;
  let right = -1;
  for (let x = Math.ceil(rulerRect.x); x < rulerRect.x + rulerRect.width; x += 1) {
    if (!inkAt(png, x, y, background)) continue;
    if (left < 0) left = x;
    right = x + 1;
  }
  assert.ok(left >= 0, "The ruler row has no ink");
  const foreground = pixelAt(png, Math.round((left + right) / 2), y);
  return { left, cellWidth: (right - left) / RULER_CELLS, background, foreground };
}

function lineNames(buffer, count) {
  const names = fixtureLines(0).map((line) => line.name);
  const result = [];
  let index = -1;
  for (let row = 0; row < count; row += 1) {
    if (!buffer.getLine(row).isWrapped) index += 1;
    result.push(names[index] ?? `line-${index}`);
  }
  return result;
}

/** The row's printed cells, consecutive cells of one grapheme cluster grouped together. */
function rowClusters(line, columns, cell) {
  const cells = [];
  let text = "";
  for (let col = 0; col < columns; col += 1) {
    line.getCell(col, cell);
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    cells.push({
      col,
      width,
      chars,
      offset: text.length,
      painted: cell.isInverse() || !cell.isBgDefault(),
      accent: cell.isFgRGB() && cell.getFgColor() === rgbValue(ACCENT),
    });
    text += chars;
  }
  const clusterEnds = [...graphemes.segment(text)].map(
    (segment) => segment.index + segment.segment.length,
  );
  const clusters = [];
  let end = 0;
  for (const entry of cells) {
    while (entry.offset >= clusterEnds[end]) end += 1;
    const last = clusters.at(-1);
    if (last && last.end === end) last.cells.push(entry);
    else clusters.push({ end, cells: [entry] });
  }
  return clusters.map((cluster) => cluster.cells);
}

function rgbValue([red, green, blue]) {
  return (red << 16) | (green << 8) | blue;
}

/** Each cell of a cluster that uses the accent color holds ink of its own color only. */
function checkClusterColors({ png, cluster, rect, grid }) {
  const kinds = [];
  for (const entry of cluster) {
    const box = {
      left: grid.left + entry.col * grid.cellWidth + 1,
      right: grid.left + (entry.col + entry.width) * grid.cellWidth - 1,
      top: rect.y,
      bottom: rect.y + rect.height,
    };
    const [color, other] = entry.accent ? [ACCENT, grid.foreground] : [grid.foreground, ACCENT];
    const own = countColor(png, box, grid.background, color, other);
    const foreign = countColor(png, box, grid.background, other, color);
    if (own < MIN_CLUSTER_INK || foreign > MAX_FOREIGN_INK) {
      kinds.push({ col: entry.col, kind: entry.accent ? "accent-color-lost" : "color-leaked" });
    }
  }
  return kinds;
}

function checkRows({ png, terminal, rows, grid }) {
  const buffer = terminal.buffer.active;
  const lastRow = buffer.cursorY;
  const names = lineNames(buffer, lastRow + 1);
  const failures = [];
  const slots = [];
  const cell = buffer.getNullCell();
  for (let row = 0; row <= lastRow; row += 1) {
    const rect = rows.get(row);
    if (!rect) {
      failures.push({ row, line: names[row], kind: "missing-row" });
      continue;
    }
    const clusters = rowClusters(buffer.getLine(row), terminal.cols, cell);
    // Color is judged on whole rows that use the accent, so a color leaking into a neighbouring
    // default-colored cell fails too.
    const checksColor = clusters.some((cluster) => cluster.some((entry) => entry.accent));
    for (const cluster of clusters) {
      const first = cluster[0];
      const columns = cluster.reduce((sum, entry) => sum + entry.width, 0);
      const left = grid.left + first.col * grid.cellWidth;
      const right = left + columns * grid.cellWidth;
      const box = { left: left + 1, right: right - 1, top: rect.y, bottom: rect.y + rect.height };
      const chars = cluster.map((entry) => entry.chars).join("");
      const isCursor = row === lastRow && first.col === buffer.cursorX;
      let kind = null;
      if (isCursor) {
        const covered = countInk(png, box, grid.background);
        const area = (box.right - box.left) * (box.bottom - box.top);
        if (covered < area * 0.25) kind = "cursor-not-drawn";
      } else if (chars.trim() !== "") {
        if (countInk(png, box, grid.background) < MIN_CLUSTER_INK) kind = "missing-ink";
      } else if (!cluster.some((entry) => entry.painted)) {
        const quarter = (right - left) / 4;
        const center = { ...box, left: left + quarter, right: right - quarter };
        if (countInk(png, center, grid.background) > 0) kind = "ink-in-blank";
      }
      const colorFailures =
        kind === null && checksColor && chars.trim() !== ""
          ? checkClusterColors({ png, cluster, rect, grid })
          : [];
      slots.push({
        row,
        line: names[row],
        col: first.col,
        width: columns,
        chars,
        isCursor,
        box,
        ok: kind === null && colorFailures.length === 0,
      });
      if (kind) failures.push({ row, line: names[row], col: first.col, char: chars, kind });
      for (const failure of colorFailures) {
        failures.push({ row, line: names[row], char: chars, ...failure });
      }
    }
  }
  return { failures, slots };
}
