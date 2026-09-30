import { describe, expect, it } from "vitest";
import { buildPandaRuns } from "@/components/panda-sprite";
import {
  PANDA_STATUS_FILL_MAPPING,
  PANDA_STATUS_LABEL_KEYS,
  pandaStatusRuns,
} from "@/components/panda-status-meta";
import {
  PANDA_STATUS_COLOR_KEYS,
  PANDA_STATUS_FRAMES,
  PANDA_STATUS_PALETTE,
  type PandaMood,
} from "@/components/panda-status-frames";

const MOODS: PandaMood[] = ["run", "ask", "err", "sleep"];

describe("PANDA_STATUS_LABEL_KEYS", () => {
  it("has one distinct panda.status.<mood> key per mood", () => {
    for (const mood of MOODS) expect(PANDA_STATUS_LABEL_KEYS[mood]).toBe(`panda.status.${mood}`);
    expect(new Set(Object.values(PANDA_STATUS_LABEL_KEYS)).size).toBe(MOODS.length);
  });
});

describe("PANDA_STATUS_FILL_MAPPING", () => {
  it("covers every theme color key that a status cell can resolve to", () => {
    for (const themeKey of Object.values(PANDA_STATUS_COLOR_KEYS)) {
      expect(typeof PANDA_STATUS_FILL_MAPPING[themeKey]).toBe("function");
    }
  });
});

describe("pandaStatusRuns", () => {
  it("splits fur and status runs so together they cover every painted pixel exactly once", () => {
    for (const size of ["small", "large"] as const) {
      for (const mood of MOODS) {
        for (const frame of PANDA_STATUS_FRAMES[size][mood]) {
          const { furRuns, statusRuns } = pandaStatusRuns(frame);
          const painted = frame.join("").replaceAll(".", "").length;
          const covered =
            furRuns.reduce((sum, run) => sum + run.width, 0) +
            statusRuns.reduce((sum, run) => sum + run.width, 0);
          expect(covered).toBe(painted);
        }
      }
    }
  });

  it("matches buildPandaRuns called directly with the fur and status-key palettes", () => {
    const frame = PANDA_STATUS_FRAMES.large.ask[0]!;
    const { furRuns, statusRuns } = pandaStatusRuns(frame);
    expect(furRuns).toEqual(buildPandaRuns(frame, PANDA_STATUS_PALETTE));
    expect(statusRuns).toEqual(buildPandaRuns(frame, PANDA_STATUS_COLOR_KEYS));
    expect(statusRuns.length).toBeGreaterThan(0);
    for (const run of statusRuns) {
      expect(run.fill === "statusWarning" || run.fill === "statusDanger").toBe(true);
    }
  });
});
