export function parseSafeInteger(value: string): number | undefined {
  const input = value.trim();
  const match = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(input);
  if (!match) {
    return undefined;
  }

  const digits = match[1] + (match[2] ?? "");
  const parsed = Number(input);
  if (digits.length === 0 || !Number.isSafeInteger(parsed)) {
    return undefined;
  }

  // Check the decimal value before floating-point rounding can hide a fraction.
  const decimalPlaces = (match[2]?.length ?? 0) - Number(match[3] ?? "0");
  if (decimalPlaces > 0 && /[1-9]/.test(digits.slice(-decimalPlaces))) {
    return undefined;
  }
  return parsed;
}
