/**
 * Positions of the items on one workspace row's plugin line that drew something. A separator
 * belongs between two drawn things, and only a badge knows whether its item drew, so each badge
 * reports in and the badges after it read the result.
 */
export type DrawnPositions = readonly number[];

export function withDrawn(drawn: DrawnPositions, position: number): DrawnPositions {
  return [...drawn, position];
}

export function withoutDrawn(drawn: DrawnPositions, position: number): DrawnPositions {
  const index = drawn.indexOf(position);
  return index < 0 ? drawn : drawn.filter((_, i) => i !== index);
}

/** `leading`: the row drew items of its own before the plugin line. */
export function needsSeparator({
  leading,
  position,
  drawn,
}: {
  leading: boolean;
  position: number;
  drawn: DrawnPositions;
}): boolean {
  return leading || drawn.some((other) => other < position);
}
