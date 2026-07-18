/**
 * Parse duration string to milliseconds.
 * Supports formats like: 5m, 30s, 1h, 2h30m, 1d, 90, etc.
 * If no unit is specified, assumes seconds.
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();

  // If it's just a number, treat as seconds
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }

  if (!/^(?:\d+[smhd])+$/.test(trimmed)) {
    throw new Error(`Invalid duration format: ${input}. Use formats like: 5m, 30s, 1h, 2h30m, 1d`);
  }

  // Parse duration with units
  let totalMs = 0;
  const regex = /(\d+)([smhd])/g;
  let match;

  while ((match = regex.exec(trimmed)) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "s":
        totalMs += value * 1000;
        break;
      case "m":
        totalMs += value * 60 * 1000;
        break;
      case "h":
        totalMs += value * 60 * 60 * 1000;
        break;
      case "d":
        totalMs += value * 24 * 60 * 60 * 1000;
        break;
    }
  }

  return totalMs;
}
