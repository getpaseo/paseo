import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import type { TFunction } from "i18next";
import { everyMsToParts } from "@/utils/schedule-format";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export interface CadencePresetOption {
  id: string;
  label: string;
  expression: string;
}

export const CUSTOM_CRON_PRESET_ID = "custom";

const CADENCE_PRESETS = [
  { id: "every-minute", labelKey: "everyMinute", expression: "* * * * *" },
  { id: "every-hour", labelKey: "everyHour", expression: "0 * * * *" },
  { id: "daily-9", labelKey: "daily9", expression: "0 9 * * *" },
  { id: "weekdays-9", labelKey: "weekdays9", expression: "0 9 * * 1-5" },
  { id: "mondays-9", labelKey: "mondays9", expression: "0 9 * * 1" },
] as const;

export function getCadencePresetOptions(t: TFunction): CadencePresetOption[] {
  return CADENCE_PRESETS.map(({ id, labelKey, expression }) => ({
    id,
    label: t(`schedules.cadence.presets.${labelKey}`),
    expression,
  }));
}

export function resolveCronPresetId(cadence: CronCadence): string {
  const expression = cadence.expression.trim();
  return (
    CADENCE_PRESETS.find((option) => option.expression === expression)?.id ?? CUSTOM_CRON_PRESET_ID
  );
}

export function resolveCronPresetDisplay(cadence: CronCadence, t: TFunction): { label: string } {
  return {
    label:
      getCadencePresetOptions(t).find((option) => option.id === resolveCronPresetId(cadence))
        ?.label ?? t("schedules.cadence.custom"),
  };
}

export function normalizeScheduleFormCadence(
  cadence: ScheduleCadence,
  timezone: string,
): CronCadence {
  if (cadence.type === "cron") {
    return { ...cadence, timezone: cadence.timezone ?? timezone };
  }

  return {
    type: "cron",
    expression: everyMsToCronExpression(cadence.everyMs),
    timezone,
  };
}

function everyMsToCronExpression(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  if (unit === "minutes") {
    return value === 1 ? "* * * * *" : `*/${Math.min(value, 59)} * * * *`;
  }
  if (unit === "hours") {
    return value === 1 ? "0 * * * *" : `0 */${Math.min(value, 23)} * * *`;
  }
  return value === 1 ? "0 9 * * *" : `0 9 */${Math.min(value, 31)} * *`;
}
