import { describe, expect, it } from "vitest";
import type { PrHint } from "@/git/pr-hint";
import { selectCheckSummary, toFilledQuarters } from "./check-summary";

function hint(overrides: Partial<PrHint>): PrHint {
  return {
    url: "https://github.com/o/r/pull/1",
    number: 1,
    state: "open",
    forge: "github",
    ...overrides,
  };
}

function checks(...statuses: string[]): PrHint["checks"] {
  return statuses.map((status, index) => ({ name: `check-${index}`, status, url: null }));
}

describe("selectCheckSummary", () => {
  it("returns nothing without a pull request", () => {
    expect(selectCheckSummary(null)).toBeNull();
  });

  it("returns nothing when the pull request reports no checks", () => {
    expect(selectCheckSummary(hint({ checksStatus: "none" }))).toBeNull();
    expect(selectCheckSummary(hint({ checks: [] }))).toBeNull();
  });

  it("passes once every check is terminal and none failed", () => {
    expect(selectCheckSummary(hint({ checks: checks("success", "success", "skipped") }))).toEqual({
      state: "passed",
      completed: 3,
      total: 3,
    });
  });

  it("counts terminal checks while others are still pending", () => {
    expect(
      selectCheckSummary(hint({ checks: checks("success", "skipped", "pending", "pending") })),
    ).toEqual({ state: "running", completed: 2, total: 4 });
  });

  it("fails as soon as one check fails, even mid-run", () => {
    expect(
      selectCheckSummary(hint({ checks: checks("success", "failure", "pending", "pending") })),
    ).toEqual({ state: "failed", completed: 4, total: 4 });
  });

  it("treats cancelled checks as finished rather than failed", () => {
    expect(selectCheckSummary(hint({ checks: checks("success", "cancelled") }))).toEqual({
      state: "passed",
      completed: 2,
      total: 2,
    });
  });

  it("treats an unrecognized status as still running", () => {
    expect(selectCheckSummary(hint({ checks: checks("success", "queued") }))).toEqual({
      state: "running",
      completed: 1,
      total: 2,
    });
  });

  it("falls back to the summary status when individual checks are absent", () => {
    expect(selectCheckSummary(hint({ checksStatus: "pending" }))).toEqual({
      state: "running",
      completed: 0,
      total: 1,
    });
    expect(selectCheckSummary(hint({ checksStatus: "failure" }))).toEqual({
      state: "failed",
      completed: 1,
      total: 1,
    });
  });

  it("prefers individual checks over the summary status", () => {
    expect(
      selectCheckSummary(hint({ checks: checks("failure"), checksStatus: "success" })),
    ).toEqual({ state: "failed", completed: 1, total: 1 });
  });
});

describe("toFilledQuarters", () => {
  it("fills nothing before the first quarter completes", () => {
    expect(toFilledQuarters({ state: "running", completed: 0, total: 8 })).toBe(0);
    expect(toFilledQuarters({ state: "running", completed: 1, total: 8 })).toBe(0);
  });

  it("fills in quarter steps", () => {
    expect(toFilledQuarters({ state: "running", completed: 2, total: 8 })).toBe(0.25);
    expect(toFilledQuarters({ state: "running", completed: 5, total: 10 })).toBe(0.5);
    expect(toFilledQuarters({ state: "running", completed: 6, total: 8 })).toBe(0.75);
  });

  it("rounds down so an unfinished run never reads as complete", () => {
    expect(toFilledQuarters({ state: "running", completed: 9, total: 10 })).toBe(0.75);
  });

  it("closes the pie only when every check is in", () => {
    expect(toFilledQuarters({ state: "passed", completed: 10, total: 10 })).toBe(1);
  });

  it("treats an empty run as empty rather than dividing by zero", () => {
    expect(toFilledQuarters({ state: "running", completed: 0, total: 0 })).toBe(0);
  });
});
