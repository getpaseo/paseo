import { describe, expect, it } from "vitest";
import {
  buildPresetCron,
  cadenceDraftToCadence,
  cadenceToDraft,
  formatCadenceSummary,
  isValidCronExpression,
  parseTimeString,
} from "./schedule-cadence";

describe("parseTimeString", () => {
  it("parses valid HH:MM", () => {
    expect(parseTimeString("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeString("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("rejects out-of-range and malformed values", () => {
    expect(parseTimeString("24:00")).toBeNull();
    expect(parseTimeString("12:60")).toBeNull();
    expect(parseTimeString("9:5")).toBeNull();
    expect(parseTimeString("nope")).toBeNull();
  });
});

describe("buildPresetCron", () => {
  it("builds daily, weekdays, and weekly expressions", () => {
    expect(buildPresetCron("daily", "09:00", 1)).toBe("0 9 * * *");
    expect(buildPresetCron("weekdays", "14:30", 1)).toBe("30 14 * * 1-5");
    expect(buildPresetCron("weekly", "08:15", 3)).toBe("15 8 * * 3");
  });

  it("returns null for invalid time", () => {
    expect(buildPresetCron("daily", "bad", 1)).toBeNull();
  });
});

describe("isValidCronExpression", () => {
  it("accepts 5-field expressions", () => {
    expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
    expect(isValidCronExpression("*/15 * * * *")).toBe(true);
  });

  it("rejects wrong field counts and stray characters", () => {
    expect(isValidCronExpression("0 9 * *")).toBe(false);
    expect(isValidCronExpression("0 9 * * * *")).toBe(false);
    expect(isValidCronExpression("0 9 * * MON")).toBe(false);
  });
});

describe("cadenceDraftToCadence", () => {
  it("converts interval drafts to everyMs", () => {
    expect(cadenceDraftToCadence({ mode: "interval", every: "30", unit: "minutes" })).toEqual({
      ok: true,
      cadence: { type: "every", everyMs: 1_800_000 },
    });
    expect(cadenceDraftToCadence({ mode: "interval", every: "2", unit: "hours" })).toEqual({
      ok: true,
      cadence: { type: "every", everyMs: 7_200_000 },
    });
  });

  it("rejects non-positive intervals", () => {
    expect(cadenceDraftToCadence({ mode: "interval", every: "0", unit: "minutes" })).toEqual({
      ok: false,
      error: "intervalInvalid",
    });
  });

  it("converts cron presets with timezone", () => {
    expect(
      cadenceDraftToCadence({
        mode: "cron",
        preset: "weekdays",
        time: "09:00",
        dayOfWeek: 1,
        expression: "",
        timezone: "America/New_York",
      }),
    ).toEqual({
      ok: true,
      cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "America/New_York" },
    });
  });

  it("uses the raw expression for custom presets", () => {
    expect(
      cadenceDraftToCadence({
        mode: "cron",
        preset: "custom",
        time: "09:00",
        dayOfWeek: 1,
        expression: "*/15 * * * *",
        timezone: "",
      }),
    ).toEqual({ ok: true, cadence: { type: "cron", expression: "*/15 * * * *" } });
  });

  it("rejects invalid custom expressions", () => {
    expect(
      cadenceDraftToCadence({
        mode: "cron",
        preset: "custom",
        time: "09:00",
        dayOfWeek: 1,
        expression: "nonsense",
        timezone: "",
      }),
    ).toEqual({ ok: false, error: "cronInvalid" });
  });
});

describe("cadenceToDraft", () => {
  it("round-trips an interval cadence in hours", () => {
    expect(cadenceToDraft({ type: "every", everyMs: 7_200_000 }, "UTC")).toEqual({
      mode: "interval",
      every: "2",
      unit: "hours",
    });
  });

  it("classifies a weekly cron back into a preset", () => {
    expect(
      cadenceToDraft({ type: "cron", expression: "15 8 * * 3", timezone: "UTC" }, "UTC"),
    ).toEqual({
      mode: "cron",
      preset: "weekly",
      time: "08:15",
      dayOfWeek: 3,
      expression: "15 8 * * 3",
      timezone: "UTC",
    });
  });

  it("falls back to custom for unclassifiable expressions", () => {
    const draft = cadenceToDraft({ type: "cron", expression: "*/15 * * * *" }, "UTC");
    expect(draft.mode).toBe("cron");
    if (draft.mode === "cron") {
      expect(draft.preset).toBe("custom");
      expect(draft.expression).toBe("*/15 * * * *");
      expect(draft.timezone).toBe("UTC");
    }
  });
});

describe("formatCadenceSummary", () => {
  it("summarizes intervals and cron presets", () => {
    expect(formatCadenceSummary({ type: "every", everyMs: 1_800_000 })).toBe("Every 30m");
    expect(formatCadenceSummary({ type: "every", everyMs: 7_200_000 })).toBe("Every 2h");
    expect(formatCadenceSummary({ type: "cron", expression: "0 9 * * *" })).toBe("Daily at 09:00");
    expect(formatCadenceSummary({ type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" })).toBe(
      "Weekdays at 09:00 (UTC)",
    );
    expect(formatCadenceSummary({ type: "cron", expression: "*/15 * * * *" })).toBe(
      "Cron: */15 * * * *",
    );
  });
});
