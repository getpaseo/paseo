import { describe, expect, it } from "vitest";
import { PANDA_GRID, PANDA_PALETTE, PANDA_SALTO_FRAMES, PANDA_WORK_FRAMES } from "./panda-frames";
import { buildPandaRuns } from "./panda-sprite";

const ALL_FRAMES = [...PANDA_WORK_FRAMES, ...PANDA_SALTO_FRAMES];

describe("panda frames", () => {
  it("are square grids that only use palette colours", () => {
    for (const frame of ALL_FRAMES) {
      expect(frame).toHaveLength(PANDA_GRID);
      for (const row of frame) {
        expect(row).toHaveLength(PANDA_GRID);
        for (const cell of row) expect(cell === "." || cell in PANDA_PALETTE).toBe(true);
      }
    }
  });

  it("differ from frame to frame, so the panda moves", () => {
    const distinct = new Set(PANDA_WORK_FRAMES.map((frame) => frame.join("")));
    expect(distinct.size).toBeGreaterThanOrEqual(6);
    expect(new Set(PANDA_SALTO_FRAMES.map((frame) => frame.join(""))).size).toBe(
      PANDA_SALTO_FRAMES.length,
    );
  });
});

describe("buildPandaRuns", () => {
  it("merges same-colour neighbours and keeps every run inside the grid", () => {
    const frame = PANDA_WORK_FRAMES[0]!;
    const runs = buildPandaRuns(frame);
    const painted = frame.join("").replaceAll(".", "").length;
    expect(runs.reduce((sum, run) => sum + run.width, 0)).toBe(painted);
    expect(runs.length).toBeLessThan(painted);
    for (const run of runs) expect(run.x + run.width).toBeLessThanOrEqual(PANDA_GRID);
  });
});
