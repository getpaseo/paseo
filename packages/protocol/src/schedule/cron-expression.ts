interface CronFieldBounds {
  min: number;
  max: number;
  name: string;
}

export interface CronFieldMatcher {
  matches(value: number): boolean;
}

export interface ParsedCronExpression {
  minute: CronFieldMatcher;
  hour: CronFieldMatcher;
  dayOfMonth: CronFieldMatcher;
  month: CronFieldMatcher;
  dayOfWeek: CronFieldMatcher;
}

const CRON_FIELD_BOUNDS: CronFieldBounds[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
];

function createRange(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function parseStepPart(part: string, bounds: CronFieldBounds): { base: string; step: number } {
  const stepParts = part.split("/");
  if (stepParts.length > 2) {
    throw new Error(`Invalid cron ${bounds.name} step`);
  }

  const [base, stepSource] = stepParts;
  const normalizedStep = stepSource?.trim();
  const step = normalizedStep === undefined ? 1 : Number.parseInt(normalizedStep, 10);
  if (
    !Number.isInteger(step) ||
    step <= 0 ||
    (normalizedStep !== undefined && String(step) !== normalizedStep)
  ) {
    throw new Error(`Invalid cron ${bounds.name} step`);
  }

  return { base, step };
}

function parseField(source: string, bounds: CronFieldBounds): CronFieldMatcher {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error(`Invalid cron ${bounds.name} field`);
  }

  const allowed = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      throw new Error(`Invalid cron ${bounds.name} field`);
    }

    const { base, step } = parseStepPart(part, bounds);

    if (base === "*") {
      for (const value of createRange(bounds.min, bounds.max, step)) {
        allowed.add(value);
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
        allowed.add(value);
      }
      continue;
    }

    if (!/^\d+$/.test(base)) {
      throw new Error(`Invalid cron ${bounds.name} value`);
    }
    const value = Number.parseInt(base, 10);
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new Error(`Invalid cron ${bounds.name} value`);
    }
    allowed.add(value);
  }

  return {
    matches(value: number): boolean {
      return allowed.has(value);
    },
  };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron expressions must have 5 fields");
  }

  return {
    minute: parseField(parts[0], CRON_FIELD_BOUNDS[0]),
    hour: parseField(parts[1], CRON_FIELD_BOUNDS[1]),
    dayOfMonth: parseField(parts[2], CRON_FIELD_BOUNDS[2]),
    month: parseField(parts[3], CRON_FIELD_BOUNDS[3]),
    dayOfWeek: parseField(parts[4], CRON_FIELD_BOUNDS[4]),
  };
}

export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid cron expression";
  }
}
