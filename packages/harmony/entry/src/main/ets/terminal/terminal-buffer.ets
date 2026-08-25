/**
 * Terminal buffer — grid of characters with attributes.
 *
 * Maintains a scrollback ring buffer of rows, each representing one
 * line in the terminal grid. Tracks cursor position, scroll region,
 * and character attributes (foreground/background color, bold, etc.).
 *
 * Based on the terminal buffer concepts from Paseo's terminal-emulator.native.tsx
 * and the xterm.js buffer model.
 */

import { TerminalColors } from './terminal-colors';

// ---------------------------------------------------------------------------
// Character cell
// ---------------------------------------------------------------------------

export interface TerminalCell {
  /** The UTF-8 code point (single character). */
  char: string;
  /** Foreground color index (0-255, or -1 for default). */
  fg: number;
  /** Background color index (0-255, or -1 for default). */
  bg: number;
  /** Bold attribute. */
  bold: boolean;
  /** Italic attribute. */
  italic: boolean;
  /** Underline attribute. */
  underline: boolean;
  /** Inverse/reverse video. */
  inverse: boolean;
}

/** Create an empty cell. */
function emptyCell(): TerminalCell {
  return {
    char: ' ',
    fg: -1,
    bg: -1,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

export class TerminalBuffer {
  /** Number of columns. */
  cols: number = 80;

  /** Number of visible rows. */
  rows: number = 24;

  /** Scrollback + visible rows. Index 0 = topmost scrollback line. */
  private lines: TerminalCell[][] = [];

  /** Cursor column (0-based). */
  cursorCol: number = 0;

  /** Cursor row relative to visible area (0 = top of visible). */
  cursorRow: number = 0;

  /** Scroll region: top row (inclusive, relative to visible). */
  scrollTop: number = 0;

  /** Scroll region: bottom row (inclusive, relative to visible). */
  scrollBottom: number = 23;

  /** Whether cursor is visible. */
  cursorVisible: boolean = true;

  /** Max scrollback lines. */
  private maxScrollback: number = 1000;

  /** Current SGR attributes for new characters. */
  private attrFg: number = -1;
  private attrBg: number = -1;
  private attrBold: boolean = false;
  private attrItalic: boolean = false;
  private attrUnderline: boolean = false;
  private attrInverse: boolean = false;

  /** Saved cursor state (for save/restore cursor sequences). */
  private savedCursorCol: number = 0;
  private savedCursorRow: number = 0;

  constructor(cols: number = 80, rows: number = 24) {
    this.resize(cols, rows);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Get the cell at (col, visibleRow). */
  getCell(col: number, visibleRow: number): TerminalCell {
    const lineIdx = this.lines.length - this.rows + visibleRow;
    if (lineIdx < 0 || lineIdx >= this.lines.length) {
      return emptyCell();
    }
    const line = this.lines[lineIdx];
    if (!line || col < 0 || col >= this.cols) {
      return emptyCell();
    }
    return line[col] ?? emptyCell();
  }

  /** Get an entire row (by visible row index). */
  getVisibleRow(row: number): TerminalCell[] {
    const lineIdx = this.lines.length - this.rows + row;
    if (lineIdx < 0 || lineIdx >= this.lines.length) {
      return this.emptyLine();
    }
    return this.lines[lineIdx] ?? this.emptyLine();
  }

  /** Number of scrollback lines (above visible area). */
  get scrollbackLines(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  /** Total lines in buffer (scrollback + visible). */
  get totalLines(): number {
    return this.lines.length;
  }

  /**
   * Write a character at the current cursor position and advance.
   */
  writeChar(char: string): void {
    this.ensureVisibleLine(this.cursorRow);
    const lineIdx = this.lines.length - this.rows + this.cursorRow;

    if (lineIdx >= 0 && lineIdx < this.lines.length) {
      const line = this.lines[lineIdx];
      if (this.cursorCol < this.cols) {
        line[this.cursorCol] = {
          char,
          fg: this.attrFg,
          bg: this.attrBg,
          bold: this.attrBold,
          italic: this.attrItalic,
          underline: this.attrUnderline,
          inverse: this.attrInverse,
        };
      }
    }

    this.cursorCol += 1;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.lineFeed();
    }
  }

  /** Write a string starting at the cursor. */
  writeString(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      // Need to use substring for multi-byte characters
      // For Phase 1, assume single ASCII byte per char
      this.writeChar(text[i]);
    }
  }

  /** Carriage return — move cursor to column 0. */
  carriageReturn(): void {
    this.cursorCol = 0;
  }

  /** Line feed — move cursor down, scroll if needed. */
  lineFeed(): void {
    if (this.cursorRow >= this.scrollBottom) {
      this.scroll();
    } else {
      this.cursorRow += 1;
    }
  }

  /** Newline — CR + LF. */
  newline(): void {
    this.carriageReturn();
    this.lineFeed();
  }

  /** Backspace. */
  backspace(): void {
    if (this.cursorCol > 0) {
      this.cursorCol -= 1;
    }
  }

  /** Tab — move to next multiple of 8. */
  tab(): void {
    this.cursorCol = ((this.cursorCol + 8) >> 3) << 3;  // Integer-only bitwise in ArkTS
    if (this.cursorCol >= this.cols) {
      this.cursorCol = this.cols - 1;
    }
  }

  /** Set the cursor position (1-based). */
  setCursorPosition(row: number, col: number): void {
    this.cursorRow = Math.max(0, Math.min(row - 1, this.rows - 1));
    this.cursorCol = Math.max(0, Math.min(col - 1, this.cols - 1));
  }

  /** Move cursor up by n rows. */
  cursorUp(n: number = 1): void {
    this.cursorRow = Math.max(this.scrollTop, this.cursorRow - n);
  }

  /** Move cursor down by n rows. */
  cursorDown(n: number = 1): void {
    this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + n);
  }

  /** Move cursor forward by n columns. */
  cursorForward(n: number = 1): void {
    this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n);
  }

  /** Move cursor backward by n columns. */
  cursorBackward(n: number = 1): void {
    this.cursorCol = Math.max(0, this.cursorCol - n);
  }

  /** Save cursor position. */
  saveCursor(): void {
    this.savedCursorCol = this.cursorCol;
    this.savedCursorRow = this.cursorRow;
  }

  /** Restore cursor position. */
  restoreCursor(): void {
    this.cursorCol = this.savedCursorCol;
    this.cursorRow = this.savedCursorRow;
  }

  /** Erase from cursor to end of line. */
  eraseLine(mode: number = 0): void {
    this.ensureVisibleLine(this.cursorRow);
    const lineIdx = this.lines.length - this.rows + this.cursorRow;
    if (lineIdx < 0 || lineIdx >= this.lines.length) return;

    const line = this.lines[lineIdx];
    switch (mode) {
      case 0: // Erase from cursor to end of line
        for (let c = this.cursorCol; c < this.cols; c += 1) {
          line[c] = emptyCell();
        }
        break;
      case 1: // Erase from start of line to cursor
        for (let c = 0; c <= this.cursorCol; c += 1) {
          line[c] = emptyCell();
        }
        break;
      case 2: // Erase entire line
        for (let c = 0; c < this.cols; c += 1) {
          line[c] = emptyCell();
        }
        break;
    }
  }

  /** Erase display. */
  eraseDisplay(mode: number = 0): void {
    switch (mode) {
      case 0: // Erase from cursor to end
        this.eraseLine(0);
        for (let r = this.cursorRow + 1; r < this.rows; r += 1) {
          this.eraseLineAt(r);
        }
        break;
      case 1: // Erase from start to cursor
        for (let r = 0; r < this.cursorRow; r += 1) {
          this.eraseLineAt(r);
        }
        this.eraseLine(1);
        break;
      case 2: // Erase entire screen
        for (let r = 0; r < this.rows; r += 1) {
          this.eraseLineAt(r);
        }
        this.cursorCol = 0;
        this.cursorRow = 0;
        break;
      case 3: // Erase scrollback
        this.lines = this.lines.slice(-this.rows);
        break;
    }
  }

  /** Set SGR attribute. */
  setSgr(code: number): void {
    switch (code) {
      case 0: // Reset
        this.attrFg = -1;
        this.attrBg = -1;
        this.attrBold = false;
        this.attrItalic = false;
        this.attrUnderline = false;
        this.attrInverse = false;
        break;
      case 1: this.attrBold = true; break;
      case 3: this.attrItalic = true; break;
      case 4: this.attrUnderline = true; break;
      case 7: this.attrInverse = true; break;
      case 22: this.attrBold = false; break;
      case 23: this.attrItalic = false; break;
      case 24: this.attrUnderline = false; break;
      case 27: this.attrInverse = false; break;
      case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
        this.attrFg = code - 30;
        break;
      case 39: this.attrFg = -1; break;
      case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
        this.attrBg = code - 40;
        break;
      case 49: this.attrBg = -1; break;
      // Bright foreground: 90-97
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
        this.attrFg = code - 90 + 8;
        break;
      // Bright background: 100-107
      case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
        this.attrBg = code - 100 + 8;
        break;
    }
  }

  /** Resize the terminal. */
  resize(cols: number, rows: number): void {
    const oldRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    this.scrollBottom = rows - 1;

    // Ensure we have at least `rows` lines
    while (this.lines.length < rows) {
      this.lines.push(this.emptyLine());
    }

    // Resize existing lines to new column width
    for (let i = 0; i < this.lines.length; i += 1) {
      const line = this.lines[i];
      while (line.length < cols) {
        line.push(emptyCell());
      }
      line.length = cols;
    }

    // Constrain cursor
    this.cursorCol = Math.min(this.cursorCol, cols - 1);
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
  }

  /**
   * Restore from a terminal snapshot (received via binary frame from daemon).
   * The snapshot contains the visible screen content + cursor state.
   */
  restoreSnapshot(visibleLines: string[], cursorRow: number, cursorCol: number): void {
    // Clear existing visible lines
    const visibleStart = Math.max(0, this.lines.length - this.rows);
    // Replace or add visible lines
    for (let i = 0; i < visibleLines.length; i += 1) {
      const lineIdx = visibleStart + i;
      const line = this.emptyLine();
      for (let c = 0; c < Math.min(visibleLines[i].length, this.cols); c += 1) {
        line[c] = {
          char: visibleLines[i][c],
          fg: -1,
          bg: -1,
          bold: false,
          italic: false,
          underline: false,
          inverse: false,
        };
      }
      if (lineIdx < this.lines.length) {
        this.lines[lineIdx] = line;
      } else {
        this.lines.push(line);
      }
    }

    this.cursorRow = cursorRow;
    this.cursorCol = cursorCol;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private emptyLine(): TerminalCell[] {
    const line: TerminalCell[] = [];
    for (let c = 0; c < this.cols; c += 1) {
      line.push(emptyCell());
    }
    return line;
  }

  private ensureVisibleLine(row: number): void {
    while (this.lines.length - this.rows + row < 0) {
      this.lines.unshift(this.emptyLine());
    }
    while (this.lines.length - this.rows + row >= this.lines.length) {
      this.lines.push(this.emptyLine());
    }
  }

  private scroll(): void {
    // Add a new empty line at the bottom of the scroll region
    const bottomIdx = this.lines.length - this.rows + this.scrollBottom + 1;
    this.lines.splice(bottomIdx, 0, this.emptyLine());

    // If scrollback limit reached, remove topmost line
    if (this.lines.length > this.rows + this.maxScrollback) {
      this.lines.shift();
    }

    // Erase the new line in the visible area
    this.eraseLineAt(this.scrollBottom);

    // Cursor stays at the same visible row
  }

  private eraseLineAt(row: number): void {
    this.ensureVisibleLine(row);
    const lineIdx = this.lines.length - this.rows + row;
    if (lineIdx >= 0 && lineIdx < this.lines.length) {
      this.lines[lineIdx] = this.emptyLine();
    }
  }
}
