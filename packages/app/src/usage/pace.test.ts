import { describe, expect, it } from "vitest";
import { usagePace } from "./pace";
import type { UsageWindow } from "./types";

const day = "2026-11-20T";
const reading = (time: string) => `${day}${time}:00.000Z`;
const window: UsageWindow = {
  id: "five_hour",
  label: "Session",
  durationSeconds: 18_000,
  usedPct: 65,
  resetsAt: reading("15:00"),
};

describe("usage pace", () => {
  it("projects the limit from the sample time and keeps it fixed between readings", () => {
    const sampledAt = reading("12:00");
    const estimate = { kind: "runsOut", at: `${day}13:04:36.923Z` };
    expect(usagePace(window, sampledAt, Date.parse(sampledAt))).toEqual(estimate);
    expect(usagePace(window, sampledAt, Date.parse(reading("12:30")))).toEqual(estimate);
  });

  it("updates after a later reading and works with a remaining percentage", () => {
    const close = reading("13:30");
    const safe = reading("14:00");
    const forecast = usagePace(window, close, Date.parse(close));
    expect(forecast.kind).toBe("remaining");
    if (forecast.kind === "remaining") expect(forecast.remainingAtResetPct).toBeCloseTo(7.14);
    expect(
      usagePace({ ...window, usedPct: undefined, remainingPct: 35 }, safe, Date.parse(safe)),
    ).toEqual({ kind: "remaining", remainingAtResetPct: 18.75 });
  });

  it("only forecasts with timing and an active, usable reading", () => {
    const sampledAt = reading("12:00");
    const now = Date.parse(sampledAt);
    expect(usagePace({ ...window, durationSeconds: undefined }, sampledAt, now)).toEqual({
      kind: "unknown",
    });
    expect(usagePace(window, null, now)).toEqual({ kind: "unknown" });
    expect(usagePace(window, reading("10:01"), now)).toEqual({ kind: "unknown" });
    expect(usagePace(window, sampledAt, Date.parse(window.resetsAt!))).toEqual({ kind: "unknown" });
    expect(usagePace({ ...window, usedPct: 100 }, sampledAt, now)).toEqual({ kind: "reached" });
  });
});
