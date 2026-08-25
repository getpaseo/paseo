/**
 * Terminal Canvas renderer.
 *
 * Draws the TerminalBuffer onto an ArkUI Canvas using CanvasRenderingContext2D.
 * Uses dirty-row tracking for efficient repaints — only re-renders rows
 * that changed since the last frame.
 *
 * The renderer is designed to be called from the terminal-canvas component's
 * onReady callback, and redrawn on each new data frame.
 */

import { TerminalBuffer } from './terminal-buffer';
import { TerminalColors } from './terminal-colors';

export class TerminalRenderer {
  private buffer: TerminalBuffer;
  private ctx: CanvasRenderingContext2D | null = null;

  /** Width of a single character cell in px. */
  private charWidth: number = 8.4;

  /** Height of a single character cell in px. */
  private charHeight: number = 17;

  /** Font string for fillText. */
  private font: string = '';

  /** Rows that need re-rendering. */
  private dirtyRows: Set<number> = new Set();

  /** Canvas pixel width. */
  private canvasWidth: number = 0;

  /** Canvas pixel height. */
  private canvasHeight: number = 0;

  /** Horizontal padding inside the canvas. */
  private padX: number = 4;

  /** Vertical padding. */
  private padY: number = 2;

  constructor(buffer: TerminalBuffer) {
    this.buffer = buffer;
  }

  /**
   * Attach to a Canvas context. Call once when the Canvas component
   * is ready.
   */
  attach(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    this.ctx = ctx;
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.recalculateFont();
  }

  /** Called when the canvas size changes. */
  resize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
    this.recalculateFont();
    this.dirtyAll();
  }

  /** Mark a specific row as dirty. */
  dirtyRow(row: number): void {
    this.dirtyRows.add(row);
  }

  /** Mark all rows dirty (full redraw). */
  dirtyAll(): void {
    for (let r = 0; r < this.buffer.rows; r += 1) {
      this.dirtyRows.add(r);
    }
    // Also mark scrollback if tracking
  }

  /**
   * Render one frame. Redraws only dirty rows.
   */
  renderFrame(): void {
    if (!this.ctx) {
      return;
    }

    const ctx = this.ctx;
    const rows = this.buffer.rows;
    const cols = this.buffer.cols;

    // Draw background
    ctx.fillStyle = TerminalColors.defaultBg;
    ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);

    // Draw dirty rows
    for (const row of this.dirtyRows) {
      if (row < 0 || row >= rows) {
        continue;
      }
      this.drawRow(ctx, row, cols);
    }

    this.dirtyRows.clear();

    // Draw cursor
    this.drawCursor(ctx);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private recalculateFont(): void {
    // Fit columns to canvas width
    const availableWidth = this.canvasWidth - this.padX * 2;
    this.charWidth = Math.max(6, availableWidth / this.buffer.cols);
    this.charHeight = this.charWidth * 2.0;
    this.font = `${this.charHeight - 2}px monospace`;
  }

  private drawRow(ctx: CanvasRenderingContext2D, row: number, cols: number): void {
    const y = this.padY + row * this.charHeight;
    const cells = this.buffer.getVisibleRow(row);

    for (let col = 0; col < cols; col += 1) {
      const x = this.padX + col * this.charWidth;
      const cell = cells[col];
      if (!cell || cell.char === ' ') {
        // Skip empty cells (background already drawn)
        // But draw background if BG is set
        if (cell && cell.bg >= 0) {
          ctx.fillStyle = TerminalColors.getBg(cell.bg);
          ctx.fillRect(x, y, this.charWidth, this.charHeight);
        }
        continue;
      }

      // Background
      if (cell.inverse) {
        ctx.fillStyle = cell.fg >= 0 ? TerminalColors.getFg(cell.fg) : TerminalColors.defaultFg;
      } else {
        ctx.fillStyle = cell.bg >= 0 ? TerminalColors.getBg(cell.bg) : TerminalColors.defaultBg;
      }
      // Only draw bg rect if it differs from terminal default bg
      if (cell.bg >= 0 || cell.inverse) {
        ctx.fillRect(x, y, this.charWidth, this.charHeight);
      }

      // Foreground
      if (cell.inverse) {
        ctx.fillStyle = TerminalColors.defaultBg;
      } else {
        ctx.fillStyle = cell.fg >= 0 ? TerminalColors.getFg(cell.fg) : TerminalColors.defaultFg;
      }

      // Font
      ctx.font = this.font;
      if (cell.bold) {
        ctx.font = `bold ${this.font}`;
      }

      // Draw character
      ctx.fillText(cell.char, x, y + this.charHeight - 3);

      // Underline
      if (cell.underline) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const uy = y + this.charHeight - 2;
        ctx.moveTo(x, uy);
        ctx.lineTo(x + this.charWidth, uy);
        ctx.stroke();
      }
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D): void {
    if (!this.buffer.cursorVisible) {
      return;
    }

    const x = this.padX + this.buffer.cursorCol * this.charWidth;
    const y = this.padY + this.buffer.cursorRow * this.charHeight;

    ctx.fillStyle = TerminalColors.cursor;
    ctx.fillRect(x, y + this.charHeight - 2, this.charWidth, 2);
  }

  /** Get the row under a (clientX, clientY) position. */
  hitTest(clientX: number, clientY: number): number {
    const y = clientY - this.padY;
    return Math.floor(y / this.charHeight);
  }
}
