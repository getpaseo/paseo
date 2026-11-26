export function formatContextPercentage(
  value: number,
  locale?: string,
  maximumFractionDigits = 0,
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits,
  }).format(value / 100);
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export interface ContextUsage {
  /** Shown as text: whole percent when derived from tokens, two decimals at most when reported. */
  percentage: number;
  /** Unrounded share that drives the ring and its color. */
  ringPercentage: number;
  usedTokens: number | null;
  maxTokens: number | null;
}

/**
 * How full the context window is. A percentage the provider reports is authoritative, so it wins
 * over the share derived from token counts, and the counts are then left out because they would
 * not match the ring.
 */
export function resolveContextUsage(input: {
  maxTokens: number | null;
  usedTokens: number | null;
  reportedPercentage: number | null | undefined;
}): ContextUsage | null {
  const { maxTokens, usedTokens, reportedPercentage } = input;
  if (
    typeof reportedPercentage === "number" &&
    Number.isFinite(reportedPercentage) &&
    reportedPercentage >= 0
  ) {
    return {
      percentage: Math.round(reportedPercentage * 100) / 100,
      ringPercentage: reportedPercentage,
      usedTokens: null,
      maxTokens: null,
    };
  }
  if (
    maxTokens === null ||
    usedTokens === null ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0 ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0
  ) {
    return null;
  }
  const ringPercentage = (usedTokens / maxTokens) * 100;
  return { percentage: Math.round(ringPercentage), ringPercentage, usedTokens, maxTokens };
}
