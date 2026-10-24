import { parseCronExpression } from "@getpaseo/protocol/schedule/cron-expression";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

interface CronDateParts {
  year: number;
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
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
      year: date.getUTCFullYear(),
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
      year,
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
    // COMPAT(scheduleEveryMs): execute legacy persisted rolling intervals until the
    // compatibility floor reaches v0.2.0. Added in v0.2.0; remove after 2027-01-17.
    return new Date(after.getTime() + cadence.everyMs);
  }

  const cron = parseCronExpression(cadence.expression);
  const readDateParts = createCronDatePartsReader(cadence.timezone);
  const weekdaySource = cadence.expression.trim().split(/\s+/)[4];
  // Use a leap year so February 29 remains possible. Leave restricted weekdays
  // to the day-field matching below.
  if (weekdaySource.startsWith("*")) {
    const months = Array.from({ length: 12 }, (_, index) => index + 1);
    const hasPossibleDate = months.some((month) => {
      if (!cron.month.matches(month)) {
        return false;
      }
      const maxDay = new Date(Date.UTC(2000, month, 0)).getUTCDate();
      const days = Array.from({ length: maxDay }, (_, index) => index + 1);
      return days.some((day) => cron.dayOfMonth.matches(day));
    });
    if (!hasPossibleDate) {
      throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
    }
  }
  // A skipped century leap year can put the next February 29 eight years away.
  const limit = 8 * 366 * 24 * 60;
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

    if (!cron.month.matches(month)) {
      const { year } = readDateParts(cursor);
      let nextMonth = month;
      while (!cron.month.matches((nextMonth % 12) + 1)) {
        nextMonth += 1;
      }
      // Start before the first local day, including positive UTC offsets.
      const nextMonthStart = Date.UTC(year, nextMonth, 1) - 24 * 60 * 60_000;
      const nextTime = Math.max(cursor.getTime() + 60_000, nextMonthStart);
      const skippedMinutes = (nextTime - cursor.getTime()) / 60_000;
      index += skippedMinutes - 1;
      cursor = new Date(nextTime);
      continue;
    }

    cursor = new Date(cursor.getTime() + 60_000);
  }

  throw new Error(`Unable to compute next run time for cron expression: ${cadence.expression}`);
}
