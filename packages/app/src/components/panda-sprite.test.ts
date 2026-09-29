import { describe, expect, it } from "vitest";
import { PANDA_COLUMNS, PANDA_FRAMES, PANDA_VIEW_ROWS, buildPandaRuns } from "./panda-sprite";

describe("buildPandaRuns", () => {
  it("draws every frame inside the sprite box, bob included", () => {
    for (const frame of PANDA_FRAMES) {
      for (const run of buildPandaRuns(frame)) {
        expect(run.x).toBeGreaterThanOrEqual(0);
        expect(run.x + run.width).toBeLessThanOrEqual(PANDA_COLUMNS);
        expect(run.y).toBeLessThan(PANDA_VIEW_ROWS);
      }
    }
  });

  it("closes the eyes by painting the pupils black", () => {
    const base = PANDA_FRAMES[0]!;
    const whites = (eyesOpen: boolean) =>
      buildPandaRuns({ ...base, eyesOpen }).filter((run) => run.fill === "#f5f5f5").length;
    expect(whites(true)).toBeGreaterThan(whites(false));
  });

  it("fills the thought bubble one dot per step and raises the bamboo", () => {
    const base = PANDA_FRAMES[0]!;
    const dots = (thoughts: number) =>
      buildPandaRuns({ ...base, thoughts })
        .filter((run) => run.y === 1 && run.fill === "#8f8f99" && run.x >= 15)
        .reduce((sum, run) => sum + run.width, 0);
    expect([0, 1, 2, 3].map(dots)).toEqual([0, 1, 2, 3]);
    const bamboo = (bambooUp: boolean) =>
      buildPandaRuns({ ...base, bambooUp }).filter((run) => run.fill === "#6fbf5b").length;
    expect(bamboo(true)).toBeGreaterThan(bamboo(false));
  });
});
