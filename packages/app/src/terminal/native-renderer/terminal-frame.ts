import type {
  PaseoTerminalFrame,
  PaseoTerminalRow,
  PaseoTerminalSelection,
} from "../../../modules/paseo-terminal/contract";
import type { TerminalCellStyleResolver } from "./colors";
import type { NativeTerminalCell, TerminalViewportState } from "./headless-terminal-state";
import type { TerminalSelectionRange } from "./terminal-selection";

/**
 * Converts the xterm viewport into the native renderer's frame. Every cell keeps its own text and
 * xterm's column span; continuation cells of wide characters (width 0) belong to the cell before
 * them. Nothing here measures or joins text: the renderer shapes rows and places the result on
 * these columns.
 */
export function buildTerminalFrame(input: {
  state: TerminalViewportState;
  columns: number;
  resolver: TerminalCellStyleResolver;
  selection: TerminalSelectionRange | null;
}): PaseoTerminalFrame {
  const grid = input.state.grid as NativeTerminalCell[][];
  return {
    columns: input.columns,
    rows: grid.map((cells) =>
      buildRow({ cells, columns: input.columns, resolver: input.resolver }),
    ),
    cursor: input.state.cursor.hidden
      ? null
      : { row: input.state.cursor.row, col: input.state.cursor.col },
    selection: input.selection
      ? toFrameSelection({ range: input.selection, firstRow: input.state.firstRow })
      : null,
  };
}

function buildRow(input: {
  cells: NativeTerminalCell[];
  columns: number;
  resolver: TerminalCellStyleResolver;
}): PaseoTerminalRow {
  let text = "";
  const cells: number[] = [];
  const styles: number[] = [];
  const lastColumn = Math.min(input.columns, input.cells.length);

  for (let col = 0; col < lastColumn; col += 1) {
    const cell = input.cells[col];
    const span = cell.width ?? 1;
    if (span <= 0) {
      continue;
    }
    const cellText = cell.char || " ";
    text += cellText;
    cells.push(cellText.length, span);

    const style = input.resolver.resolve(cell);
    const previous = styles.length - 4;
    if (
      previous >= 0 &&
      styles[previous + 1] === style.foreground &&
      styles[previous + 2] === style.background &&
      styles[previous + 3] === style.flags
    ) {
      styles[previous] += span;
    } else {
      styles.push(span, style.foreground, style.background, style.flags);
    }
  }

  return { text, cells, styles };
}

function toFrameSelection(input: {
  range: TerminalSelectionRange;
  firstRow: number;
}): PaseoTerminalSelection {
  return {
    startRow: input.range.start.row - input.firstRow,
    startCol: input.range.start.col,
    endRow: input.range.end.row - input.firstRow,
    endCol: input.range.end.col,
  };
}
