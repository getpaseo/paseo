import type { DiffFragment } from "./types";

interface SourceRange {
  start: number;
  end: number;
}

/** A paint owns this cache, so closing Find leaves no extra retained layout data. */
export type RangeMeasurements = WeakMap<DiffFragment, readonly number[]>;

export function firstRangeEndingAfter(ranges: readonly SourceRange[], offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function fragmentRangeBounds(input: {
  fragment: DiffFragment;
  start: number;
  end: number;
  measurements?: RangeMeasurements;
}): { before: number; width: number } {
  const { fragment, start, end, measurements } = input;
  const first = firstRangeEndingAfter(fragment.graphemes, start);
  let low = first;
  let high = fragment.graphemes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (fragment.graphemes[middle].start < end) low = middle + 1;
    else high = middle;
  }
  let advances = measurements?.get(fragment);
  if (!advances) {
    const positions = [0];
    for (const grapheme of fragment.graphemes)
      positions.push(positions[positions.length - 1] + grapheme.width);
    advances = positions;
    measurements?.set(fragment, advances);
  }
  // A match inside a combining/emoji cluster paints the whole visible glyph.
  return { before: advances[first], width: advances[low] - advances[first] };
}
