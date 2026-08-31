/**
 * Find the largest projected-item limit in `[1, maxLimit]` whose selected page
 * fits `budgetBytes`. `measurePageBytes` re-selects the page for a candidate limit
 * and returns its serialized size; page size is assumed monotonic non-decreasing
 * in limit (a larger projected window never yields a smaller page).
 *
 * The budget is enforced on the *selected* page rather than a pre-selection entry
 * count because projection can expand a reduced limit back over a wide/merged tool
 * entry's source span, so the only reliable size is the one measured after
 * selection. Returns `maxLimit` unchanged when the full page already fits, and `1`
 * as a forward-progress floor when even the smallest page exceeds the budget (an
 * unpageable wide entry) so pagination never stalls.
 */
export function largestFittingProjectedLimit(input: {
  maxLimit: number;
  budgetBytes: number;
  measurePageBytes: (limit: number) => number;
}): number {
  const { maxLimit, budgetBytes, measurePageBytes } = input;
  if (maxLimit <= 1) {
    return maxLimit;
  }
  if (measurePageBytes(maxLimit) <= budgetBytes) {
    return maxLimit;
  }

  let low = 1;
  let high = maxLimit - 1;
  let best = 1;
  while (low <= high) {
    const mid = low + Math.floor((high - low) / 2);
    if (measurePageBytes(mid) <= budgetBytes) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
