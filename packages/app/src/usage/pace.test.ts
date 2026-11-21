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
    expect(usagePace(window, close, Date.parse(close))).toEqual({ kind: "tight" });
    expect(
      usagePace({ ...window, usedPct: undefined, remainingPct: 35 }, safe, Date.parse(safe)),
    ).toEqual({ kind: "onTrack" });
  });

  it("projects a weekly window after 100 minutes when 6% is already used", () => {
    const sampledAt = "2026-11-21T10:28:17.000Z";
    const weekly: UsageWindow = {
      id: "gemini-weekly",
      label: "Gemini · Weekly",
      durationSeconds: 604_800,
      usedPct: 6,
      resetsAt: "2026-11-28T08:48:17.000Z",
    };
    expect(usagePace(weekly, sampledAt, Date.parse("2026-11-21T10:33:03Z"))).toEqual({
      kind: "runsOut",
      at: "2026-11-22T12:34:57.000Z",
    });
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
