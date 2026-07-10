import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  CADENCE_PRESET_OPTIONS,
  getCadencePresetLabel,
  normalizeScheduleFormCadence,
  resolveCronPresetDisplay,
  resolveCronPresetId,
} from "./schedule-cadence-options";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

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

  it("uses the caller translator for preset options rendered by a localized component", () => {
    const translate = ((key: string) => `translated:${key}`) as never;
    const label = (
      getCadencePresetLabel as (
        option: (typeof CADENCE_PRESET_OPTIONS)[number],
        translator: typeof translate,
      ) => string
    )(CADENCE_PRESET_OPTIONS[0], translate);

    expect(label).toBe("translated:schedules.cadence.everyMinute");
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

  it("localizes the selected cadence label with the active app language", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(
      resolveCronPresetDisplay({ type: "cron", expression: "0 9 * * *", timezone: "UTC" }),
    ).toEqual({ label: "每天 9:00" });
    expect(resolveCronPresetDisplay({ type: "cron", expression: "*/5 * * * *" })).toEqual({
      label: "自定义 Cron",
    });
  });
});
