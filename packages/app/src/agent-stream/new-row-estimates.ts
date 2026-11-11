interface EstimatedRow {
  id: string;
  kind: string;
}

export interface NewRowEstimates<Row extends EstimatedRow> {
  /** Called with every row list; a row whose id the previous list did not have is new. */
  noteRows: (rows: readonly Row[]) => void;
  /** Estimated size of an unmeasured new row, or undefined to use the list's average for its type. */
  estimate: (row: Row) => number | undefined;
  /** A row can change kind under the same id (a thought becomes a tool call); its current kind counts. */
  noteMeasured: (row: Row, size: number) => void;
}

// A row that enters the list is a streamed row at the end, a tool call an expanded summary reveals,
// or an older row loaded at the start. Its first measured size is close to constant per kind: one
// line of text, a tool call header, a thought line. So a new row is estimated at the first measured
// size of the last new row of its kind, and is laid out near its real size before it is measured.
// The list's average for a type is the size of whole turns and is far off for any of these. Rows of
// the first list are not new; they keep the average until measured.
export function createNewRowEstimates<Row extends EstimatedRow>(): NewRowEstimates<Row> {
  let previousRowIds: ReadonlySet<string> | null = null;
  const unmeasuredRowIds = new Set<string>();
  const firstSizeByKind = new Map<string, number>();

  return {
    noteRows(rows) {
      const rowIds = new Set(rows.map((row) => row.id));
      if (previousRowIds) {
        for (const row of rows) {
          if (!previousRowIds.has(row.id)) unmeasuredRowIds.add(row.id);
        }
      }
      for (const rowId of unmeasuredRowIds) {
        if (!rowIds.has(rowId)) unmeasuredRowIds.delete(rowId);
      }
      previousRowIds = rowIds;
    },
    estimate(row) {
      return unmeasuredRowIds.has(row.id) ? firstSizeByKind.get(row.kind) : undefined;
    },
    noteMeasured(row, size) {
      if (!unmeasuredRowIds.delete(row.id)) return;
      firstSizeByKind.set(row.kind, size);
    },
  };
}
