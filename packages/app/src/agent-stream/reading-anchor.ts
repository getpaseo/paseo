interface RowGeometry {
  id: string;
  top: number;
  height: number;
}

// A row must clear the reading line before the next row takes ownership.
const READING_POSITION_OFFSET_PX = 8;
export interface ReadingRowReplacements {
  get(id: string): string | undefined;
}
const NO_REPLACEMENTS: ReadingRowReplacements = new Map();

// Content coordinates survive user scrolling. Layout commits replace the geometry;
// scroll events reuse it, without another DOM measurement pass.
export function createReadingAnchor() {
  let anchor: { id: string; top: number } | null = null;
  let geometry: readonly RowGeometry[] = [];
  const readingRow = (scrollTop: number) =>
    geometry.find((row) => row.top + row.height > scrollTop + READING_POSITION_OFFSET_PX);
  const getRowId = (replacements = NO_REPLACEMENTS) =>
    anchor ? (replacements.get(anchor.id) ?? anchor.id) : null;
  const project = (
    scrollTop: number,
    row: Pick<RowGeometry, "id" | "top"> | undefined,
    replacements = NO_REPLACEMENTS,
  ) => scrollTop + (anchor && row && row.id === getRowId(replacements) ? row.top - anchor.top : 0);
  return {
    getRowId,
    getReadingRowId: (scrollTop: number) =>
      readingRow(scrollTop)?.id ?? geometry.at(-1)?.id ?? null,
    project,
    reset() {
      anchor = null;
    },
    scroll(scrollTop: number) {
      const next = readingRow(scrollTop);
      anchor = next ? { id: next.id, top: next.top } : null;
    },
    reconcile(
      scrollTop: number,
      rows: readonly RowGeometry[],
      userScrolled = false,
      replacements = NO_REPLACEMENTS,
    ): number {
      geometry = rows;
      const previous = anchor && rows.find((row) => row.id === getRowId(replacements));
      // The first virtualized commit can precede its mounted range. Keep the
      // pinned reader until it mounts, rather than adopting an unrelated row.
      if (anchor && !previous && !userScrolled) return scrollTop;
      const correctedTop = project(scrollTop, previous ?? undefined, replacements);
      // A prepend can expose the bottom of an estimated row above the reader.
      // Do not transfer ownership to it until the user moves the reading position.
      const next = previous && !userScrolled ? previous : readingRow(correctedTop);
      anchor = next ? { id: next.id, top: next.top } : null;
      return correctedTop;
    },
  };
}
