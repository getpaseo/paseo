import { describe, expect, it } from "vitest";
import { resolvePercentages } from "./format";

describe("provider usage percentage display", () => {
  it("derives remaining percentage from used percentage", () => {
    const window = { id: "weekly", label: "Weekly", usedPct: 29 };

    expect(resolvePercentages(window, "remaining")).toEqual({
      displayed: 71,
      fillPct: 71,
      used: 29,
    });
  });

  it("derives used percentage from remaining percentage", () => {
    const window = { id: "daily", label: "Daily", remainingPct: 30 };

    expect(resolvePercentages(window, "used")).toEqual({
      displayed: 70,
      fillPct: 70,
      used: 70,
    });
  });

  it("uses the remaining complement for the bar fill when showing remaining", () => {
    const window = { id: "session", label: "Session", remainingPct: 8 };

    expect(resolvePercentages(window, "remaining")).toEqual({
      displayed: 8,
      fillPct: 8,
      used: 92,
    });
  });

  it("returns no percentage when the provider reports neither value", () => {
    const window = { id: "session", label: "Session" };

    expect(resolvePercentages(window, "remaining")).toEqual({
      displayed: null,
      fillPct: null,
      used: null,
    });
  });
});
