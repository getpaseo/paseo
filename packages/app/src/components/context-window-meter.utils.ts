/**
 * One decimal below ten of a unit, whole units above: `1.2k` carries real information at four
 * digits, `12.3k` is noise at five. Whole values keep their bare form, so 1000 reads `1k` rather
 * than `1.0k`.
 */
function formatScaledCount(scaled: number): string {
  if (scaled >= 10) {
    return Math.round(scaled).toString();
  }
  const rounded = Math.round(scaled * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1);
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatScaledCount(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${formatScaledCount(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}
