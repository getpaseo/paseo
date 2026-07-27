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

export function isNewAgentSchedule(schedule: ScheduleSummary): boolean {
  return schedule.target.type === "new-agent";
}

export function scheduleProductName(schedule: ScheduleSummary): "Heartbeat" | "Schedule" {
  return schedule.target.type === "agent" ? "Heartbeat" : "Schedule";
}

export function scheduleProductLabel(schedule: ScheduleSummary): string {
  return schedule.target.type === "agent"
    ? i18n.t("schedules.product.heartbeat")
    : i18n.t("schedules.product.schedule");
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
  return (
    firstPromptLine ||
    i18n.t("schedules.format.untitled", {
      productName: scheduleProductLabel(schedule).toLowerCase(),
    })
  );
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

function unitLabel(value: number, unit: IntervalUnit): string {
  if (unit === "minutes") {
    return value === 1
      ? i18n.t("schedules.format.unitMinute")
      : i18n.t("schedules.format.unitMinutes");
  }
  if (unit === "hours") {
    return value === 1 ? i18n.t("schedules.format.unitHour") : i18n.t("schedules.format.unitHours");
  }
  return value === 1 ? i18n.t("schedules.format.unitDay") : i18n.t("schedules.format.unitDays");
}

function formatEvery(everyMs: number): string {
  const { value, unit } = everyMsToParts(everyMs);
  return i18n.t("schedules.format.everyInterval", {
    count: value,
    unit: unitLabel(value, unit),
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
    return i18n.t("schedules.format.everyMinute");
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
      ? i18n.t("schedules.format.everyHour")
      : i18n.t("schedules.format.everyHourAt", { minutes: pad2(minuteNum) });
  }

  if (!/^\d+$/.test(hour)) {
    return null;
  }
  const time = `${pad2(Number.parseInt(hour, 10))}:${pad2(minuteNum)}`;
  const timezone = cadence.timezone ?? "UTC";
  const dayLabel = describeCronDay(dayOfWeek);
  return dayLabel ? i18n.t("schedules.format.atTime", { when: dayLabel, time, timezone }) : null;
}

function describeCronDay(dayOfWeek: string): string | null {
  if (dayOfWeek === "*") {
    return i18n.t("schedules.format.daily");
  }
  if (dayOfWeek === "1-5") {
    return i18n.t("schedules.format.weekdays");
  }
  if (dayOfWeek === "0,6" || dayOfWeek === "6,0") {
    return i18n.t("schedules.format.weekends");
  }
  if (/^\d$/.test(dayOfWeek)) {
    const dayKey = DAY_KEYS[Number.parseInt(dayOfWeek, 10)];
    if (!dayKey) {
      return null;
    }
    return i18n.t("schedules.format.dayPlural", {
      day: i18n.t(`schedules.format.days.${dayKey}`),
    });
  }
  return null;
}

export function validateCron(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) {
    return i18n.t("schedules.format.enterCron");
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
    return i18n.t("schedules.format.soon");
  }
  if (diffMs < MS_PER_MINUTE) {
    return i18n.t("schedules.format.soon");
  }
  if (diffMs < MS_PER_HOUR) {
    return i18n.t("schedules.format.inMinutes", {
      count: Math.round(diffMs / MS_PER_MINUTE),
    });
  }
  if (diffMs < MS_PER_DAY) {
    return i18n.t("schedules.format.inHours", {
      count: Math.round(diffMs / MS_PER_HOUR),
    });
  }
  return i18n.t("schedules.format.inDays", {
    count: Math.round(diffMs / MS_PER_DAY),
  });
}
