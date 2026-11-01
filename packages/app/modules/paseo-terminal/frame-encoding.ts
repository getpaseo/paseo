import type { PaseoTerminalCursor, PaseoTerminalFrame, PaseoTerminalSelection } from "./contract";

/** A frame as it crosses to native. */
export interface NativePaseoTerminalFrame {
  columns: number;
  rows: string[];
  cursor?: PaseoTerminalCursor;
  selection?: PaseoTerminalSelection;
}

/**
 * Rows cross as `cells;styles;text`, with the numbers comma separated. One string per row keeps
 * prop conversion to a single copy instead of one call per number, and the string is also the
 * native shaping cache key, so an unchanged row costs one lookup.
 *
 * A missing cursor or selection is left out rather than sent as `null`: Expo on iOS fails to
 * convert `null` into an optional record field and then drops the whole frame.
 */
export function encodeTerminalFrame(frame: PaseoTerminalFrame): NativePaseoTerminalFrame {
  const native: NativePaseoTerminalFrame = {
    columns: frame.columns,
    rows: frame.rows.map((row) => `${row.cells.join(",")};${row.styles.join(",")};${row.text}`),
  };
  if (frame.cursor) native.cursor = frame.cursor;
  if (frame.selection) native.selection = frame.selection;
  return native;
}
