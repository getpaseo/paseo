import { describe, expect, it } from "vitest";
import { PANDA_COLUMNS, PANDA_FRAMES, PANDA_ROWS, buildPandaRuns } from "./panda-sprite";

describe("buildPandaRuns", () => {
  it("draws every frame inside the sprite box, bob included", () => {
    for (const frame of PANDA_FRAMES) {
      for (const run of buildPandaRuns(frame)) {
        expect(run.x + run.width).toBeLessThanOrEqual(PANDA_COLUMNS);
        expect(run.y).toBeLessThan(PANDA_ROWS + 1);
      }
    }
  });

  it("closes the eyes by painting the pupil black", () => {
    const whites = (open: boolean) =>
      buildPandaRuns({ offsetY: 0, eyesOpen: open }).filter((run) => run.fill === "#f5f5f5").length;
    expect(whites(true)).toBeGreaterThan(whites(false));
  });
});
