const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h|d)$/u;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export type DurationInput = number | string;

export function parseDurationMs(value: DurationInput, fieldName = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${fieldName} must be a positive finite number of milliseconds`);
    }
    return Math.trunc(value);
  }
  const trimmed = value.trim();
  const match = DURATION_PATTERN.exec(trimmed);
  if (match === null) {
    throw new Error(
      `${fieldName} must be a positive duration like "30s", "15m", "2h", or "14d" (got ${JSON.stringify(value)})`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === undefined ? undefined : UNIT_MS[unit];
  if (multiplier === undefined) {
    throw new Error(`${fieldName} has unsupported unit in ${JSON.stringify(value)}`);
  }
  const total = amount * multiplier;
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new Error(`${fieldName} is out of range: ${JSON.stringify(value)}`);
  }
  return total;
}
