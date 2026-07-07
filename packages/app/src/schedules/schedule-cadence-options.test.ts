import { describe, expect, it } from "vitest";
import {
  CADENCE_PRESET_OPTIONS,
  normalizeScheduleFormCadence,
  resolveCronPresetId,
} from "./schedule-cadence-options";

describe("schedule cadence form options", () => {
  it("offers the approved cron preset vocabulary", () => {
    expect(CADENCE_PRESET_OPTIONS.map((option) => option.label)).toEqual([
      "Every minute",
      "Every hour",
      "Daily 9:00",
      "Weekdays 9:00",
      "Mondays 9:00",
    ]);
  });

  it("maps interval cadences to cron cadences for the form", () => {
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "* * * * *",
      timezone: "Europe/Madrid",
    });
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 60 * 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "0 * * * *",
      timezone: "Europe/Madrid",
    });
    expect(
      normalizeScheduleFormCadence({ type: "every", everyMs: 24 * 60 * 60_000 }, "Europe/Madrid"),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "Europe/Madrid",
    });
  });

  it("maps unsupported intervals to the closest custom cron expression", () => {
    const cadence = normalizeScheduleFormCadence(
      { type: "every", everyMs: 5 * 60_000 },
      "Europe/Madrid",
    );

    expect(cadence).toEqual({
      type: "cron",
      expression: "*/5 * * * *",
      timezone: "Europe/Madrid",
    });
    expect(resolveCronPresetId(cadence)).toBe("custom");
  });
});
