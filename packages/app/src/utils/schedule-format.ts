import type { ScheduleCadence, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { validateCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import { i18n } from "@/i18n/i18next";

export type IntervalUnit = "minutes" | "hours" | "days";
type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = MS_PER_MINUTE * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

const UNIT_MS: Record<IntervalUnit, number> = {
  minutes: MS_PER_MINUTE,
  hours: MS_PER_HOUR,
  days: MS_PER_DAY,
};

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const SINGULAR_UNIT_KEY: Record<IntervalUnit, "minute" | "hour" | "day"> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export function resolveScheduleTitle(schedule: ScheduleSummary): string {
  const name = schedule.name?.trim();
  if (name) {
    return name;
  }
  if (schedule.target.type === "new-agent") {
    const configTitle = schedule.target.config.title?.trim();
    if (configTitle) {
      return configTitle;
    }
  }
  const firstPromptLine = schedule.prompt
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstPromptLine || i18n.t("schedules.format.untitled");
}

export function everyMsToParts(ms: number): { value: number; unit: IntervalUnit } {
  if (!Number.isFinite(ms) || ms <= 0) {
    return { value: 1, unit: "hours" };
  }
  if (ms % MS_PER_DAY === 0) {
    return { value: ms / MS_PER_DAY, unit: "days" };
  }
  if (ms % MS_PER_HOUR === 0) {
    return { value: ms / MS_PER_HOUR, unit: "hours" };
  }
  return { value: Math.max(1, Math.round(ms / MS_PER_MINUTE)), unit: "minutes" };
}

export function partsToEveryMs(value: number, unit: IntervalUnit): number {
  const normalized = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  return normalized * UNIT_MS[unit];
}

function formatEvery(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  const unitKey = value === 1 ? SINGULAR_UNIT_KEY[unit] : unit;
  return i18n.t("schedules.format.every", {
    count: value,
    unit: i18n.t(`schedules.format.units.${unitKey}`),
  });
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "every") {
    return formatEvery(cadence.everyMs);
  }
  return describeCron(cadence) ?? cadence.expression;
}

/**
 * Humanize a handful of common 5-field cron shapes. Returns null when the
 * expression is valid but not one of the recognized patterns (callers fall
 * back to showing the raw expression).
 */
export function describeCron(cadence: CronCadence): string | null {
  const trimmed = cadence.expression.trim();
  if (validateCron(trimmed) !== null) {
    return null;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = trimmed.split(/\s+/);

  // Only humanize the simple "fixed time" family: literal minute/hour with the
  // date fields either wildcarded or a recognized day-of-week constraint.
  const minuteNum = Number.parseInt(minute, 10);
  const isLiteralMinute = /^\d+$/.test(minute);
  const isWildcardMonth = month === "*";
  const isWildcardDom = dayOfMonth === "*";

  if (minute === "*" && hour === "*" && isWildcardMonth && isWildcardDom && dayOfWeek === "*") {
    return i18n.t("schedules.format.cron.everyMinute");
  }

  if (!isLiteralMinute || !isWildcardMonth || !isWildcardDom) {
    return null;
  }

  // "Every hour" / "Every hour at :MM"
  if (hour === "*") {
    if (dayOfWeek !== "*") {
      return null;
    }
    return minuteNum === 0
      ? i18n.t("schedules.format.cron.everyHour")
      : i18n.t("schedules.format.cron.everyHourAt", { minute: pad2(minuteNum) });
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  const day = describeCronDay(dayOfWeek);
  if (!day) {
    return null;
  }
  if (day === "daily") {
    return i18n.t("schedules.format.cron.dailyAt", { time, timezone });
  }
  if (day === "weekdays") {
    return i18n.t("schedules.format.cron.weekdaysAt", { time, timezone });
  }
  if (day === "weekends") {
    return i18n.t("schedules.format.cron.weekendsAt", { time, timezone });
  }
  return i18n.t("schedules.format.cron.dayAt", {
    day: i18n.t(`schedules.format.days.${day}`),
    time,
    timezone,
  });
}

function describeCronDay(
  dayOfWeek: string,
): "daily" | "weekdays" | "weekends" | (typeof DAY_KEYS)[number] | null {
  if (dayOfWeek === "*") {
    return "daily";
  }
  if (dayOfWeek === "1-5") {
    return "weekdays";
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return "weekends";
  }
  if (/^\d$/.test(dayOfWeek)) {
    return DAY_KEYS[Number.parseInt(dayOfWeek, 10)] ?? null;
  }
  return null;
}

export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return "Enter a cron expression";
  }

  const error = validateCronExpression(trimmed);
  return error?.replace(/^Invalid cron /, "Invalid ") ?? null;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Forward-relative description of the next run, e.g. "in 3h", "in 2d", "soon".
 * Returns "" when there is no scheduled next run.
 */
export function formatNextRun(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return "";
  }

  const diffMs = target - Date.now();
  if (diffMs <= 0) {
    return i18n.t("schedules.format.nextRun.soon");
  }
  if (diffMs < MS_PER_MINUTE) {
    return i18n.t("schedules.format.nextRun.soon");
  }
  if (diffMs < MS_PER_HOUR) {
    return i18n.t("schedules.format.nextRun.inMinutes", {
      count: Math.round(diffMs / MS_PER_MINUTE),
    });
  }
  if (diffMs < MS_PER_DAY) {
    return i18n.t("schedules.format.nextRun.inHours", {
      count: Math.round(diffMs / MS_PER_HOUR),
    });
  }
  return i18n.t("schedules.format.nextRun.inDays", {
    count: Math.round(diffMs / MS_PER_DAY),
  });
}
