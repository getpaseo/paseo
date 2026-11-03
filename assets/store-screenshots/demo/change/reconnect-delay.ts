export interface ReconnectDelayOptions {
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff with equal jitter. Half of each delay is fixed and half
 * is random, so a relay restart spreads reconnects out instead of every client
 * retrying on the same tick.
 */
export function getReconnectDelayMs(
  attempt: number,
  options: ReconnectDelayOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
