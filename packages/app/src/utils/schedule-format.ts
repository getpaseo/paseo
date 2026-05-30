import type { ScheduleCadence, ScheduleSummary } from "@getpaseo/protocol/schedule/types";

/**
 * Pure, dependency-free helpers for presenting schedules.
 *
 * Cron is a 5-field expression (minute hour day-of-month month day-of-week),
 * evaluated by the daemon in UTC. The validation here mirrors the daemon's
 * structural parser in packages/server/src/server/schedule/cron.ts so the
 * client preview rejects exactly what the server would reject.
 */

export type IntervalUnit = "minutes" | "hours" | "days";

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
  return describeCron(cadence.expression) ?? cadence.expression;
}

/**
 * Humanize a handful of common 5-field cron shapes. Returns null when the
 * expression is valid but not one of the recognized patterns (callers fall
 * back to showing the raw expression).
 */
export function describeCron(expr: string): string | null {
  const trimmed = expr.trim();
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

  if (dayOfWeek === "*") {
    return `Daily at ${time} UTC`;
  }
  if (dayOfWeek === "1-5") {
    return `Weekdays at ${time} UTC`;
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return `Weekends at ${time} UTC`;
  }
  if (/^\d$/.test(dayOfWeek)) {
    const day = DAY_NAMES[Number.parseInt(dayOfWeek, 10)];
    if (day) {
      return `${day}s at ${time} UTC`;
    }
  }
  return null;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

interface CronFieldBounds {
  min: number;
  max: number;
  name: string;
}

const CRON_FIELD_BOUNDS: CronFieldBounds[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
];

function validateCronField(source: string, bounds: CronFieldBounds): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return `Invalid ${bounds.name} field`;
  }

  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      return `Invalid ${bounds.name} field`;
    }

    const [base, stepSource] = part.split("/");
    if (stepSource !== undefined) {
      const step = Number.parseInt(stepSource, 10);
      if (!Number.isInteger(step) || step <= 0 || String(step) !== stepSource.trim()) {
        return `Invalid ${bounds.name} step`;
      }
    }

    if (base === "*") {
      continue;
    }

    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start > end || start < bounds.min || end > bounds.max) {
        return `Invalid ${bounds.name} range`;
      }
      continue;
    }

    if (!/^\d+$/.test(base)) {
      return `Invalid ${bounds.name} value`;
    }
    const value = Number.parseInt(base, 10);
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      return `Invalid ${bounds.name} value`;
    }
  }

  return null;
}

/**
 * Returns null when the expression is a structurally valid 5-field cron the
 * daemon would accept, otherwise a human-readable error message.
 */
export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return "Enter a cron expression";
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return "Cron expressions must have 5 fields";
  }

  for (let index = 0; index < CRON_FIELD_BOUNDS.length; index += 1) {
    const error = validateCronField(fields[index], CRON_FIELD_BOUNDS[index]);
    if (error) {
      return error;
    }
  }

  return null;
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
