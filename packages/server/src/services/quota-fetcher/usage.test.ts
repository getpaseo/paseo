import { describe, expect, it } from "vitest";
import { balanceToneFromRemaining, toneFromUsedPct, usedPctOf } from "./usage.js";

describe("toneFromUsedPct", () => {
  // Thresholds must match deriveTone in the app's provider-usage/tone.ts, which is what
  // the client applies when a window arrives without a tone.
  it.each([
    [0, "ok"],
    [69.9, "ok"],
    [70, "warning"],
    [90, "warning"],
    [90.1, "danger"],
    [100, "danger"],
    [150, "danger"],
  ])("%s%% used is %s", (usedPct, expected) => {
    expect(toneFromUsedPct(usedPct)).toBe(expected);
  });

  it("is neutral when the percentage is unknown", () => {
    expect(toneFromUsedPct(null)).toBe("default");
    expect(toneFromUsedPct(undefined)).toBe("default");
  });
});

describe("usedPctOf", () => {
  it("computes a percentage of the limit", () => {
    expect(usedPctOf(15.79, 42.5)).toBeCloseTo(37.15, 2);
  });

  it("is unknown when either side is missing", () => {
    expect(usedPctOf(null, 100)).toBeNull();
    expect(usedPctOf(50, null)).toBeNull();
  });

  // A zero limit would divide to Infinity and render as a full red bar.
  it("is unknown when the limit is zero or negative", () => {
    expect(usedPctOf(50, 0)).toBeNull();
    expect(usedPctOf(50, -1)).toBeNull();
  });
});

describe("balanceToneFromRemaining", () => {
  // Kept for balances with no limit, where no percentage can be computed. It only
  // escalates at exhaustion, which is why anything with a limit should use
  // toneFromUsedPct instead.
  it("stays ok until nothing is left", () => {
    expect(balanceToneFromRemaining(0.01)).toBe("ok");
    expect(balanceToneFromRemaining(0)).toBe("danger");
    expect(balanceToneFromRemaining(null)).toBe("default");
  });
});
