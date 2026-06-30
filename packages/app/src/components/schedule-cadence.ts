import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

export type CadenceMode = "interval" | "cron";
export type IntervalUnit = "minutes" | "hours";
export type CronPreset = "daily" | "weekdays" | "weekly" | "custom";

export interface IntervalCadenceDraft {
  mode: "interval";
  every: string;
  unit: IntervalUnit;
}

export interface CronCadenceDraft {
  mode: "cron";
  preset: CronPreset;
  /** Wall-clock time as "HH:MM" used to build daily/weekdays/weekly presets. */
  time: string;
  /** 0 (Sunday) - 6 (Saturday); used by the weekly preset. */
  dayOfWeek: number;
  /** Raw 5-field cron expression used by the custom preset. */
  expression: string;
  timezone: string;
}

export type CadenceDraft = IntervalCadenceDraft | CronCadenceDraft;

export type CadenceBuildResult =
  | { ok: true; cadence: ScheduleCadence }
  | { ok: false; error: string };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function getDeviceTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.trim().length > 0 ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export function parseTimeString(time: string): { hour: number; minute: number } | null {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

/** Light 5-field cron validation — the daemon performs authoritative validation. */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  return fields.every((field) => /^[0-9*,\-/]+$/.test(field));
}

export function buildPresetCron(
  preset: Exclude<CronPreset, "custom">,
  time: string,
  dayOfWeek: number,
): string | null {
  const parsed = parseTimeString(time);
  if (!parsed) {
    return null;
  }
  const { hour, minute } = parsed;
  if (preset === "daily") {
    return `${minute} ${hour} * * *`;
  }
  if (preset === "weekdays") {
    return `${minute} ${hour} * * 1-5`;
  }
  const day = Math.max(0, Math.min(6, Math.floor(dayOfWeek)));
  return `${minute} ${hour} * * ${day}`;
}

export function cadenceDraftToCadence(draft: CadenceDraft): CadenceBuildResult {
  if (draft.mode === "interval") {
    const value = Number.parseInt(draft.every.trim(), 10);
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, error: "intervalInvalid" };
    }
    const everyMs = draft.unit === "hours" ? value * HOUR_MS : value * MINUTE_MS;
    return { ok: true, cadence: { type: "every", everyMs } };
  }

  const timezone = draft.timezone.trim() || undefined;
  if (draft.preset === "custom") {
    const expression = draft.expression.trim();
    if (!isValidCronExpression(expression)) {
      return { ok: false, error: "cronInvalid" };
    }
    return { ok: true, cadence: { type: "cron", expression, ...(timezone ? { timezone } : {}) } };
  }

  const expression = buildPresetCron(draft.preset, draft.time, draft.dayOfWeek);
  if (!expression) {
    return { ok: false, error: "timeInvalid" };
  }
  return { ok: true, cadence: { type: "cron", expression, ...(timezone ? { timezone } : {}) } };
}

export function defaultCronDraft(timezone: string): CronCadenceDraft {
  return {
    mode: "cron",
    preset: "daily",
    time: "09:00",
    dayOfWeek: 1,
    expression: "0 9 * * *",
    timezone,
  };
}

export function defaultIntervalDraft(): IntervalCadenceDraft {
  return { mode: "interval", every: "30", unit: "minutes" };
}

function classifyCronExpression(
  expression: string,
): { preset: Exclude<CronPreset, "custom">; time: string; dayOfWeek: number } | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteField, hourField, dom, month, dow] = fields;
  const minute = Number.parseInt(minuteField, 10);
  const hour = Number.parseInt(hourField, 10);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) {
    return null;
  }
  if (dom !== "*" || month !== "*") {
    return null;
  }
  const time = `${pad2(hour)}:${pad2(minute)}`;
  if (dow === "*") {
    return { preset: "daily", time, dayOfWeek: 1 };
  }
  if (dow === "1-5") {
    return { preset: "weekdays", time, dayOfWeek: 1 };
  }
  const day = Number.parseInt(dow, 10);
  if (Number.isInteger(day) && day >= 0 && day <= 6) {
    return { preset: "weekly", time, dayOfWeek: day };
  }
  return null;
}

export function cadenceToDraft(cadence: ScheduleCadence, fallbackTimezone: string): CadenceDraft {
  if (cadence.type === "every") {
    if (cadence.everyMs % HOUR_MS === 0 && cadence.everyMs >= HOUR_MS) {
      return { mode: "interval", every: String(cadence.everyMs / HOUR_MS), unit: "hours" };
    }
    const minutes = Math.max(1, Math.round(cadence.everyMs / MINUTE_MS));
    return { mode: "interval", every: String(minutes), unit: "minutes" };
  }

  const timezone = cadence.timezone?.trim() || fallbackTimezone;
  const classified = classifyCronExpression(cadence.expression);
  if (classified) {
    return {
      mode: "cron",
      preset: classified.preset,
      time: classified.time,
      dayOfWeek: classified.dayOfWeek,
      expression: cadence.expression,
      timezone,
    };
  }
  return {
    mode: "cron",
    preset: "custom",
    time: "09:00",
    dayOfWeek: 1,
    expression: cadence.expression,
    timezone,
  };
}

export function formatCadenceSummary(cadence: ScheduleCadence): string {
  if (cadence.type === "every") {
    if (cadence.everyMs % HOUR_MS === 0 && cadence.everyMs >= HOUR_MS) {
      return `Every ${cadence.everyMs / HOUR_MS}h`;
    }
    const minutes = Math.max(1, Math.round(cadence.everyMs / MINUTE_MS));
    return `Every ${minutes}m`;
  }

  const tzSuffix = cadence.timezone ? ` (${cadence.timezone})` : "";
  const classified = classifyCronExpression(cadence.expression);
  if (!classified) {
    return `Cron: ${cadence.expression}${tzSuffix}`;
  }
  if (classified.preset === "daily") {
    return `Daily at ${classified.time}${tzSuffix}`;
  }
  if (classified.preset === "weekdays") {
    return `Weekdays at ${classified.time}${tzSuffix}`;
  }
  return `${WEEKDAY_LABELS[classified.dayOfWeek]} at ${classified.time}${tzSuffix}`;
}
