import * as pty from "node-pty";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import { randomUUID } from "crypto";

const { Terminal } = xterm;

export interface Cell {
  char: string;
  fg: number | undefined;
  bg: number | undefined;
  fgMode?: number; // 0=default, 1=16 ANSI, 2=256, 3=RGB
  bgMode?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Pos {
  row: number;
  col: number;
}

export interface TerminalState {
  rows: number;
  cols: number;
  grid: Cell[][];
  scrollback: Cell[][];
  cursor: Pos;
}

export interface CellChange {
  row: number;
  col: number;
  cell: Cell;
}

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "mouse"; row: number; col: number; button: number; action: "down" | "up" | "move" };

export type ServerMessage =
  | { type: "full"; state: TerminalState }
  | { type: "diff"; changes: CellChange[]; cursor: Pos };

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  send(msg: ClientMessage): void;
  subscribe(listener: (msg: ServerMessage) => void): () => void;
  getState(): TerminalState;
  kill(): void;
}

export interface CreateTerminalOptions {
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  name?: string;
}

function extractCell(terminal: TerminalType, row: number, col: number): Cell {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(row);
  if (!line) {
    return { char: " ", fg: undefined, bg: undefined };
  }

  const cell = line.getCell(col);
  if (!cell) {
    return { char: " ", fg: undefined, bg: undefined };
  }

  // Color modes from xterm.js: 0=DEFAULT, 1=16 colors (ANSI), 2=256 colors, 3=RGB
  // getFgColorMode() returns packed value with mode in upper byte (e.g. 0x01000000 for mode 1)
  const fgModeRaw = cell.getFgColorMode();
  const bgModeRaw = cell.getBgColorMode();
  const fgMode = fgModeRaw >> 24;
  const bgMode = bgModeRaw >> 24;

  // Only return color if not default (mode 0)
  const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
  const bg = bgMode !== 0 ? cell.getBgColor() : undefined;

  return {
    char: cell.getChars() || " ",
    fg,
    bg,
    fgMode: fgMode !== 0 ? fgMode : undefined,
    bgMode: bgMode !== 0 ? bgMode : undefined,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
  };
}

function extractGrid(terminal: TerminalType): Cell[][] {
  const grid: Cell[][] = [];
  const buffer = terminal.buffer.active;
  // Visible viewport starts at baseY
  const baseY = buffer.baseY;

  for (let row = 0; row < terminal.rows; row++) {
    const rowCells: Cell[] = [];
    for (let col = 0; col < terminal.cols; col++) {
      rowCells.push(extractCell(terminal, baseY + row, col));
    }
    grid.push(rowCells);
  }

  return grid;
}

function extractScrollback(terminal: TerminalType): Cell[][] {
  const scrollback: Cell[][] = [];
  const buffer = terminal.buffer.active;
  // baseY is the first row of the visible viewport (0-indexed)
  // Lines 0 to baseY-1 are in scrollback, lines baseY onwards are visible
  const scrollbackLines = buffer.baseY;

  for (let row = 0; row < scrollbackLines; row++) {
    const rowCells: Cell[] = [];
    const line = buffer.getLine(row);
    for (let col = 0; col < terminal.cols; col++) {
      if (line) {
        const cell = line.getCell(col);
        if (cell) {
          const fgModeRaw = cell.getFgColorMode();
          const bgModeRaw = cell.getBgColorMode();
          const fgMode = fgModeRaw >> 24;
          const bgMode = bgModeRaw >> 24;
          const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
          const bg = bgMode !== 0 ? cell.getBgColor() : undefined;
          rowCells.push({
            char: cell.getChars() || " ",
            fg,
            bg,
            fgMode: fgMode !== 0 ? fgMode : undefined,
            bgMode: bgMode !== 0 ? bgMode : undefined,
            bold: cell.isBold() !== 0,
            italic: cell.isItalic() !== 0,
            underline: cell.isUnderline() !== 0,
          });
        } else {
          rowCells.push({ char: " ", fg: undefined, bg: undefined });
        }
      } else {
        rowCells.push({ char: " ", fg: undefined, bg: undefined });
      }
    }
    scrollback.push(rowCells);
  }

  return scrollback;
}

export async function createTerminal(options: CreateTerminalOptions): Promise<TerminalSession> {
  const {
    cwd,
    shell = process.env.SHELL || "/bin/sh",
    env = {},
    rows = 24,
    cols = 80,
    name = "Terminal",
  } = options;

  const id = randomUUID();
  const listeners = new Set<(msg: ServerMessage) => void>();
  let killed = false;

  // Create xterm.js headless terminal
  const terminal = new Terminal({
    rows,
    cols,
    scrollback: 1000,
    allowProposedApi: true,
  });

  // Create PTY
  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      ...env,
      TERM: "xterm-256color",
    },
  });

  // Pipe PTY output to terminal emulator
  ptyProcess.onData((data) => {
    if (killed) return;
    terminal.write(data, () => {
      // Notify listeners of changes
      const state = getState();
      for (const listener of listeners) {
        listener({ type: "full", state });
      }
    });
  });

  ptyProcess.onExit(() => {
    killed = true;
  });

  function getState(): TerminalState {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
      grid: extractGrid(terminal),
      scrollback: extractScrollback(terminal),
      cursor: {
        row: terminal.buffer.active.cursorY,
        col: terminal.buffer.active.cursorX,
      },
    };
  }

  function send(msg: ClientMessage): void {
    if (killed) return;

    switch (msg.type) {
      case "input":
        ptyProcess.write(msg.data);
        break;
      case "resize":
        terminal.resize(msg.cols, msg.rows);
        ptyProcess.resize(msg.cols, msg.rows);
        break;
      case "mouse":
        // Mouse events can be sent as escape sequences if terminal supports it
        // For now, we'll just ignore them - can be implemented later
        break;
    }
  }

  function subscribe(listener: (msg: ServerMessage) => void): () => void {
    listeners.add(listener);

    // Send initial full state
    queueMicrotask(() => {
      if (listeners.has(listener)) {
        listener({ type: "full", state: getState() });
      }
    });

    return () => {
      listeners.delete(listener);
    };
  }

  function kill(): void {
    if (killed) return;
    killed = true;
    ptyProcess.kill();
    terminal.dispose();
  }

  // Small delay to let shell initialize
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    id,
    name,
    cwd,
    send,
    subscribe,
    getState,
    kill,
  };
}
