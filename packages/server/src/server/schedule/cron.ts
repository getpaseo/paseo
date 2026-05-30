import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

interface CronFieldMatcher {
  matches(value: number): boolean;
}

function buildValueSet(values: Iterable<number>): Set<number> {
  return new Set(values);
}

function createRange(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function parseField(
  source: string,
  bounds: { min: number; max: number; name: string },
): CronFieldMatcher {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error(`Invalid cron ${bounds.name} field`);
  }

  const values = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`Invalid cron ${bounds.name} field`);
    }

    const [base, stepSource] = part.split("/");
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron ${bounds.name} step`);
    }

    if (base === "*") {
      for (const value of createRange(bounds.min, bounds.max, step)) {
        values.add(value);
      }
      continue;
    }

    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start > end || start < bounds.min || end > bounds.max) {
        throw new Error(`Invalid cron ${bounds.name} range`);
      }
      for (const value of createRange(start, end, step)) {
        values.add(value);
      }
      continue;
    }

    const value = Number.parseInt(base, 10);
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`Invalid cron ${bounds.name} value`);
    }
    values.add(value);
  }

  const allowed = buildValueSet(values);
  return {
    matches(value: number): boolean {
      return allowed.has(value);
    },
  };
}

interface ParsedCronExpression {
  minute: CronFieldMatcher;
  hour: CronFieldMatcher;
  dayOfMonth: CronFieldMatcher;
  month: CronFieldMatcher;
  dayOfWeek: CronFieldMatcher;
}

interface CronDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron expressions must have 5 fields");
  }

  return {
    minute: parseField(parts[0], { min: 0, max: 59, name: "minute" }),
    hour: parseField(parts[1], { min: 0, max: 23, name: "hour" }),
    dayOfMonth: parseField(parts[2], { min: 1, max: 31, name: "day-of-month" }),
    month: parseField(parts[3], { min: 1, max: 12, name: "month" }),
    dayOfWeek: parseField(parts[4], { min: 0, max: 6, name: "day-of-week" }),
  };
}

function startOfNextMinute(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes() + 1,
      0,
      0,
    ),
  );
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid cron time zone: ${timeZone}`);
  }
}

function createCronDatePartsReader(timeZone: string | undefined): (date: Date) => CronDateParts {
  if (timeZone === undefined) {
    return (date: Date) => ({
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    });
  }

  assertValidTimeZone(timeZone);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (date: Date) => {
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") {
        values[part.type] = part.value;
      }
    }

    const year = Number.parseInt(values.year, 10);
    const month = Number.parseInt(values.month, 10);
    const dayOfMonth = Number.parseInt(values.day, 10);

    return {
      minute: Number.parseInt(values.minute, 10),
      hour: Number.parseInt(values.hour, 10),
      dayOfMonth,
      month,
      dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
    };
  };
}

export function validateScheduleCadence(cadence: ScheduleCadence): void {
  if (cadence.type === "cron") {
    parseCronExpression(cadence.expression);
    if (cadence.timezone !== undefined) {
      assertValidTimeZone(cadence.timezone);
    }
  }
}

export function computeNextRunAt(cadence: ScheduleCadence, after: Date): Date {
  if (cadence.type === "every") {
    return new Date(after.getTime() + cadence.everyMs);
  }

  const cron = parseCronExpression(cadence.expression);
  const readDateParts = createCronDatePartsReader(cadence.timezone);
  const limit = 366 * 24 * 60;
  let cursor = startOfNextMinute(after);

  for (let index = 0; index < limit; index += 1) {
    const { minute, hour, dayOfMonth, month, dayOfWeek } = readDateParts(cursor);

    if (
      cron.minute.matches(minute) &&
      cron.hour.matches(hour) &&
      cron.dayOfMonth.matches(dayOfMonth) &&
      cron.month.matches(month) &&
      cron.dayOfWeek.matches(dayOfWeek)
    ) {
      return cursor;
    }

    cursor = new Date(cursor.getTime() + 60_000);
  }

  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}
