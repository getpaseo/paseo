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

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export type ScheduleKind = "schedule" | "heartbeat";

export function scheduleKind(schedule: ScheduleSummary): ScheduleKind {
  return schedule.target.type === "agent" ? "heartbeat" : "schedule";
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
  return firstPromptLine || i18n.t(`schedules.kinds.${scheduleKind(schedule)}.untitled`);
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

const SINGLE_UNIT: Record<IntervalUnit, "minute" | "hour" | "day"> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

function formatEvery(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  // Explicit singular keys: languages without a "one" plural category (Chinese, Japanese,
  // Korean) would otherwise render "every 1 minute".
  return value === 1
    ? i18n.t(`schedules.cadence.every.${SINGLE_UNIT[unit]}`)
    : i18n.t(`schedules.cadence.every.${unit}`, { count: value });
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
    return i18n.t("schedules.cadence.cron.everyMinute");
  }

  if (!isLiteralMinute || !isWildcardMonth || !isWildcardDom) {
    return null;
  }

  // Every hour, or every hour at a fixed minute.
  if (hour === "*") {
    if (dayOfWeek !== "*") {
      return null;
    }
    return minuteNum === 0
      ? i18n.t("schedules.cadence.cron.everyHour")
      : i18n.t("schedules.cadence.cron.everyHourAt", { minute: pad2(minuteNum) });
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  const dayKey = describeCronDayKey(dayOfWeek);
  return dayKey ? i18n.t(`schedules.cadence.cron.${dayKey}`, { time, timezone }) : null;
}

function describeCronDayKey(dayOfWeek: string): string | null {
  if (dayOfWeek === "*") {
    return "daily";
  }
  if (dayOfWeek === "1-5") {
    return "weekdays";
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return "weekends";
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    return `weekly.${dayOfWeek}`;
  }
  return null;
}

export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return i18n.t("schedules.cadence.cronRequired");
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
  if (diffMs < MS_PER_MINUTE) {
    return i18n.t("schedules.nextRun.soon");
  }
  if (diffMs < MS_PER_HOUR) {
    return i18n.t("schedules.nextRun.minutes", { count: Math.round(diffMs / MS_PER_MINUTE) });
  }
  if (diffMs < MS_PER_DAY) {
    return i18n.t("schedules.nextRun.hours", { count: Math.round(diffMs / MS_PER_HOUR) });
  }
  return i18n.t("schedules.nextRun.days", { count: Math.round(diffMs / MS_PER_DAY) });
}
