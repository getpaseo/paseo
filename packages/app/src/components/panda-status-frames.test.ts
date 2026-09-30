import { describe, expect, it } from "vitest";
import {
  PANDA_STATUS_COLOR_KEYS,
  PANDA_STATUS_FRAMES,
  PANDA_STATUS_GRID,
  PANDA_STATUS_PALETTE,
  type PandaMood,
} from "./panda-status-frames";

const MOODS: PandaMood[] = ["run", "ask", "err", "sleep"];
const SIZES = ["small", "large"] as const;
const EXPECTED_FRAME_COUNTS: Record<PandaMood, number> = { run: 3, ask: 2, err: 2, sleep: 2 };
const KNOWN_CELLS = new Set([
  ...Object.keys(PANDA_STATUS_PALETTE),
  ...Object.keys(PANDA_STATUS_COLOR_KEYS),
]);

function expectKnownFrame(frame: readonly string[], grid: number) {
  expect(frame).toHaveLength(grid);
  for (const row of frame) {
    expect(row).toHaveLength(grid);
    for (const cell of row) expect(cell === "." || KNOWN_CELLS.has(cell)).toBe(true);
  }
}

describe("panda status frames", () => {
  it("are square grids of the size's dimension, using only known palette cells", () => {
    for (const size of SIZES) {
      const grid = PANDA_STATUS_GRID[size];
      for (const mood of MOODS) {
        for (const frame of PANDA_STATUS_FRAMES[size][mood]) expectKnownFrame(frame, grid);
      }
    }
  });

  it("give run a 3-frame loop and every other mood a 2-frame loop, for both sizes", () => {
    for (const size of SIZES) {
      for (const mood of MOODS) {
        expect(PANDA_STATUS_FRAMES[size][mood]).toHaveLength(EXPECTED_FRAME_COUNTS[mood]);
      }
    }
  });

  it("never repeats a frame inside one mood's loop", () => {
    for (const size of SIZES) {
      for (const mood of MOODS) {
        const frames = PANDA_STATUS_FRAMES[size][mood];
        expect(new Set(frames.map((frame) => frame.join("\n"))).size).toBe(frames.length);
      }
    }
  });

  it("uses hex colors for every fur/contour palette entry", () => {
    for (const color of Object.values(PANDA_STATUS_PALETTE))
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("keeps the status cells out of the fixed fur palette", () => {
    for (const cell of Object.keys(PANDA_STATUS_COLOR_KEYS)) {
      expect(PANDA_STATUS_PALETTE[cell]).toBeUndefined();
    }
  });
});
