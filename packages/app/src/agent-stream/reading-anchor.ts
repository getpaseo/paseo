import type { DisclosureTriggerEdge } from "./strategy";

interface RowGeometry {
  id: string;
  top: number;
  height: number;
}

const edgeOf = (row: RowGeometry, edge: DisclosureTriggerEdge) =>
  edge === "top" ? row.top : row.top + row.height;

// A row must clear the reading line before the next row takes ownership.
const READING_POSITION_OFFSET_PX = 8;
export interface ReadingRowReplacements {
  get(id: string): string | undefined;
}
const NO_REPLACEMENTS: ReadingRowReplacements = new Map();

// Content coordinates survive user scrolling. Layout commits replace the geometry;
// scroll events reuse it, without another DOM measurement pass.
export function createReadingAnchor() {
  // The row being read keeps its top. A disclosure pins the edge of its row the trigger sits on,
  // with the offset at the toggle: a toggle that shrinks the content lets the browser clamp the
  // offset before the next reconcile reads it.
  let anchor: {
    id: string;
    edge: DisclosureTriggerEdge;
    position: number;
    pinnedScrollTop?: number;
  } | null = null;
  const anchorTop = (row: RowGeometry) => ({ id: row.id, edge: "top" as const, position: row.top });
  let geometry: readonly RowGeometry[] = [];
  const readingRow = (scrollTop: number) =>
    geometry.find((row) => row.top + row.height > scrollTop + READING_POSITION_OFFSET_PX);
  const getRowId = (replacements = NO_REPLACEMENTS) =>
    anchor ? (replacements.get(anchor.id) ?? anchor.id) : null;
  const project = (
    scrollTop: number,
    row: RowGeometry | undefined,
    replacements = NO_REPLACEMENTS,
  ) =>
    anchor && row && row.id === getRowId(replacements)
      ? (anchor.pinnedScrollTop ?? scrollTop) + edgeOf(row, anchor.edge) - anchor.position
      : scrollTop;
  return {
    getRowId,
    getReadingRowId: (scrollTop: number) =>
      readingRow(scrollTop)?.id ?? geometry.at(-1)?.id ?? null,
    project,
    reset() {
      anchor = null;
    },
    // A disclosure names the row that owns its trigger and the edge the trigger sits on. That
    // edge stays in place through the toggle, even when another row sits under the reading line.
    pin(row: RowGeometry, edge: DisclosureTriggerEdge, scrollTop: number) {
      anchor = { id: row.id, edge, position: edgeOf(row, edge), pinnedScrollTop: scrollTop };
    },
    scroll(scrollTop: number) {
      const next = readingRow(scrollTop);
      anchor = next ? anchorTop(next) : null;
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
      anchor = next ? anchorTop(next) : null;
      return correctedTop;
    },
  };
}
