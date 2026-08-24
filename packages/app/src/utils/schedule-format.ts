import type { ScheduleCadence, ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { validateCronExpression } from "@getpaseo/protocol/schedule/cron-expression";

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

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export function scheduleProductName(schedule: ScheduleSummary): "Heartbeat" | "Schedule" {
  return schedule.target.type === "agent" ? "Heartbeat" : "Schedule";
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
  return firstPromptLine || `Untitled ${scheduleProductName(schedule).toLowerCase()}`;
}

function pluralize(value: number, noun: string): string {
  return value === 1 ? `1 ${noun}` : `${value} ${noun}s`;
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

const UNIT_NOUN: Record<IntervalUnit, string> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

function formatEvery(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  return `Every ${pluralize(value, UNIT_NOUN[unit])}`;
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
    return "Every minute";
  }

  if (!isLiteralMinute || !isWildcardMonth || !isWildcardDom) {
    return null;
  }

  // "Every hour" / "Every hour at :MM"
  if (hour === "*") {
    if (dayOfWeek !== "*") {
      return null;
    }
    return minuteNum === 0 ? "Every hour" : `Every hour at :${pad2(minuteNum)}`;
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  const dayLabel = describeCronDay(dayOfWeek);
  return dayLabel ? `${dayLabel} at ${time} ${timezone}` : null;
}

function describeCronDay(dayOfWeek: string): string | null {
  if (dayOfWeek === "*") {
    return "Daily";
  }
  if (dayOfWeek === "1-5") {
    return "Weekdays";
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return "Weekends";
  }
  if (/^\d$/.test(dayOfWeek)) {
    const day = DAY_NAMES[Number.parseInt(dayOfWeek, 10)];
    return day ? `${day}s` : null;
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
    return "soon";
  }
  if (diffMs < MS_PER_MINUTE) {
    return "soon";
  }
  if (diffMs < MS_PER_HOUR) {
    return `in ${Math.round(diffMs / MS_PER_MINUTE)}m`;
  }
  if (diffMs < MS_PER_DAY) {
    return `in ${Math.round(diffMs / MS_PER_HOUR)}h`;
  }
  return `in ${Math.round(diffMs / MS_PER_DAY)}d`;
}
