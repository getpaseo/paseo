export interface FindSeedInput {
  term: string;
  /** The term the search addon is currently decorating, or null when nothing is set. */
  previousTerm: string | null;
  hasSelection: boolean;
  /** The buffer line at the top of the visible screen. */
  viewportY: number;
}

export interface FindSeedSelection {
  column: number;
  row: number;
  length: number;
}

/**
 * The cell to select before searching, or null to leave the start position alone.
 *
 * A term @xterm/addon-search has not seen restarts from the start of the current
 * selection, or from row 0 when nothing is selected — which lands the first match at the
 * top of the scrollback rather than on screen. Selecting one cell at the top of the
 * viewport starts the search where the user is looking; the match then replaces the seed.
 * A repeated term must not be seeded: that is what steps to the next match.
 */
export function resolveFindSeed({
  term,
  previousTerm,
  hasSelection,
  viewportY,
}: FindSeedInput): FindSeedSelection | null {
  if (term === previousTerm || hasSelection) {
    return null;
  }
  return { column: 0, row: viewportY, length: 1 };
}
