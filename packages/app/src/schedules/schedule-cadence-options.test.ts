import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  getCadencePresetOptions,
  normalizeScheduleFormCadence,
  resolveCronPresetDisplay,
  resolveCronPresetId,
} from "./schedule-cadence-options";

const english = i18n.getFixedT("en");
const chinese = i18n.getFixedT("zh-CN");

describe("schedule cadence form options", () => {
  it("offers the approved cron preset vocabulary", () => {
    expect(getCadencePresetOptions(english).map((option) => option.label)).toEqual([
      "Every minute",
      "Every hour",
      "Daily 9:00",
      "Weekdays 9:00",
      "Mondays 9:00",
    ]);
  });

  it("labels presets and custom cron in the app language", () => {
    expect(getCadencePresetOptions(chinese).map((option) => option.label)).toEqual([
      "每分钟",
      "每小时",
      "每天 9:00",
      "工作日 9:00",
      "每周一 9:00",
    ]);
    expect(resolveCronPresetDisplay({ type: "cron", expression: "*/5 * * * *" }, chinese)).toEqual({
      label: "自定义 cron",
    });
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
