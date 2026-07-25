/**
 * Convert an exact rolling interval to an equivalent five-field cron cadence.
 * Returns null when cron's calendar boundaries would change the interval.
 */
export function everyMsToFiveFieldCron(everyMs: number): string | null {
  const minutes = everyMs / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    return null;
  }
  if (minutes < 60 && 60 % minutes === 0) {
    return `*/${minutes} * * * *`;
  }
  if (minutes === 60) {
    return "0 * * * *";
  }
  if (minutes % 60 !== 0) {
    return null;
  }
  const hours = minutes / 60;
  if (hours < 24 && 24 % hours === 0) {
    return `0 */${hours} * * *`;
  }
  if (hours === 24) {
    return "0 0 * * *";
  }
  return null;
}
