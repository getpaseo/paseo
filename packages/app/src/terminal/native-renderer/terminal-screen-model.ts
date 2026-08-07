import type {
  NativeHeadlessTerminal,
  TerminalBufferBounds,
  TerminalRowRange,
  TerminalViewportState,
} from "./headless-terminal-state";

export type TerminalScrollMode = "following" | "scrolled";

export interface TerminalScrollSnapshot {
  mode: TerminalScrollMode;
  firstRow: number;
  visibleRows: number;
  oldestRow: number;
  newestRow: number;
  currentViewport: TerminalRowRange;
  bottomViewport: TerminalRowRange;
}

export interface TerminalScreenState {
  viewport: TerminalViewportState;
  scroll: TerminalScrollSnapshot;
}

export interface TerminalScreenModel {
  sync(input: TerminalScreenSyncInput): TerminalScreenState;
  scrollUp(input: TerminalScreenScrollInput): TerminalScreenState;
  scrollDown(input: TerminalScreenScrollInput): TerminalScreenState;
  returnToBottom(input: TerminalScreenSyncInput): TerminalScreenState;
  reset(): void;
}

export interface TerminalScreenModelOptions {
  terminal: NativeHeadlessTerminal;
}

export interface TerminalScreenSyncInput {
  visibleRows: number;
}

export interface TerminalScreenScrollInput extends TerminalScreenSyncInput {
  rows: number;
}

interface TerminalScrollState {
  mode: TerminalScrollMode;
  firstRow: number;
}

export function createNativeTerminalScreenModel(
  options: TerminalScreenModelOptions,
): TerminalScreenModel {
  let scrollState: TerminalScrollState = { mode: "following", firstRow: 0 };

  function render(input: TerminalScreenSyncInput): TerminalScreenState {
    const bounds = options.terminal.getBufferBounds();
    const visibleRows = resolveVisibleRows({ requestedRows: input.visibleRows, bounds });
    const bottomViewport = resolveBottomViewport({ bounds, visibleRows });
    const hasScrollableHistory = bounds.oldestRow < bottomViewport.firstRow;
    const mode = hasScrollableHistory ? scrollState.mode : "following";
    const firstRow =
      mode === "following"
        ? bottomViewport.firstRow
        : clamp(scrollState.firstRow, bounds.oldestRow, bottomViewport.firstRow);
    const viewport = options.terminal.getViewportState({ firstRow, rowCount: visibleRows });
    scrollState = {
      mode,
      firstRow,
    };

    return {
      viewport,
      scroll: {
        mode,
        firstRow,
        visibleRows,
        oldestRow: bounds.oldestRow,
        newestRow: bounds.newestRow,
        currentViewport: rowRange({ firstRow, visibleRows, newestRow: bounds.newestRow }),
        bottomViewport,
      },
    };
  }

  function scrollBy(input: TerminalScreenScrollInput & { direction: -1 | 1 }): TerminalScreenState {
    const screen = render(input);
    const rowDelta = Math.max(0, Math.floor(input.rows)) * input.direction;
    const nextFirstRow = clamp(
      screen.scroll.firstRow + rowDelta,
      screen.scroll.oldestRow,
      screen.scroll.bottomViewport.firstRow,
    );
    const mode = nextFirstRow >= screen.scroll.bottomViewport.firstRow ? "following" : "scrolled";
    scrollState = { mode, firstRow: nextFirstRow };
    return render(input);
  }

  return {
    sync: render,
    scrollUp(input: TerminalScreenScrollInput): TerminalScreenState {
      return scrollBy({ ...input, direction: -1 });
    },
    scrollDown(input: TerminalScreenScrollInput): TerminalScreenState {
      return scrollBy({ ...input, direction: 1 });
    },
    returnToBottom(input: TerminalScreenSyncInput): TerminalScreenState {
      scrollState = { mode: "following", firstRow: 0 };
      return render(input);
    },
    reset(): void {
      scrollState = { mode: "following", firstRow: 0 };
    },
  };
}

function resolveVisibleRows(input: {
  requestedRows: number;
  bounds: TerminalBufferBounds;
}): number {
  const availableRows = input.bounds.newestRow - input.bounds.oldestRow + 1;
  const requestedRows = Math.floor(input.requestedRows);
  if (requestedRows <= 0) {
    return Math.min(input.bounds.rows, availableRows);
  }
  return clamp(requestedRows, 1, availableRows);
}

function resolveBottomViewport(input: {
  bounds: TerminalBufferBounds;
  visibleRows: number;
}): TerminalRowRange {
  const firstRow = Math.max(input.bounds.oldestRow, input.bounds.newestRow - input.visibleRows + 1);
  return rowRange({ firstRow, visibleRows: input.visibleRows, newestRow: input.bounds.newestRow });
}

function rowRange(input: {
  firstRow: number;
  visibleRows: number;
  newestRow: number;
}): TerminalRowRange {
  return {
    firstRow: input.firstRow,
    lastRow: Math.min(input.newestRow, input.firstRow + input.visibleRows - 1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
