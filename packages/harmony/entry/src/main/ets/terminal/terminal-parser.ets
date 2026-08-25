/**
 * Terminal ANSI escape sequence parser.
 *
 * Parses raw terminal output text into discrete operations on a
 * TerminalBuffer. Handles the subset of ANSI/xterm escape sequences
 * that Paseo agents actually emit:
 *
 *   - CSI sequences: cursor movement, erase, SGR (colors)
 *   - OSC sequences: window title (ignored for now)
 *   - Control characters: CR, LF, TAB, BS, BEL
 *   - Printable characters
 *
 * Based on the escape sequence handling in Paseo's terminal emulator.
 */

import { TerminalBuffer } from './terminal-buffer';

export class TerminalParser {
  private buffer: TerminalBuffer;

  /** Parser state machine. */
  private state: 'ground' | 'escape' | 'csi' | 'osc' = 'ground';

  /** Accumulated parameter string for CSI/OSC sequences. */
  private params: string = '';

  /** CSI parameter separator character. */
  private csiSeparator: string = '';

  constructor(buffer: TerminalBuffer) {
    this.buffer = buffer;
  }

  /**
   * Process a chunk of terminal output text.
   * Called for each WebSocket binary frame payload.
   */
  process(data: Uint8Array): void {
    for (let i = 0; i < data.length; i += 1) {
      const byte = data[i];
      const char = String.fromCharCode(byte);

      switch (this.state) {
        case 'ground':
          this.processGround(byte, char);
          break;
        case 'escape':
          this.processEscape(byte, char);
          break;
        case 'csi':
          this.processCsi(byte, char);
          break;
        case 'osc':
          this.processOsc(byte, char);
          break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // State: ground (normal text)
  // -----------------------------------------------------------------------

  private processGround(byte: number, char: string): void {
    switch (byte) {
      case 0x1B: // ESC
        this.state = 'escape';
        break;
      case 0x0D: // CR
        this.buffer.carriageReturn();
        break;
      case 0x0A: // LF
        this.buffer.lineFeed();
        break;
      case 0x09: // TAB
        this.buffer.tab();
        break;
      case 0x08: // BS
        this.buffer.backspace();
        break;
      case 0x07: // BEL — ignore
        break;
      default:
        if (byte >= 0x20) {
          // Printable character
          this.buffer.writeChar(char);
        }
        break;
    }
  }

  // -----------------------------------------------------------------------
  // State: escape (just received ESC)
  // -----------------------------------------------------------------------

  private processEscape(byte: number, char: string): void {
    switch (byte) {
      case 0x5B: // '[' — CSI sequence
        this.state = 'csi';
        this.params = '';
        break;
      case 0x5D: // ']' — OSC sequence
        this.state = 'osc';
        this.params = '';
        break;
      case 0x37: // '7' — Save cursor
        this.buffer.saveCursor();
        this.state = 'ground';
        break;
      case 0x38: // '8' — Restore cursor
        this.buffer.restoreCursor();
        this.state = 'ground';
        break;
      case 0x44: // 'D' — Index (cursor down, scroll if needed)
        this.buffer.lineFeed();
        this.state = 'ground';
        break;
      case 0x4D: // 'M' — Reverse index (cursor up)
        this.buffer.cursorUp();
        this.state = 'ground';
        break;
      case 0x63: // 'c' — Reset to initial state
        this.buffer.resize(this.buffer.cols, this.buffer.rows);
        this.state = 'ground';
        break;
      default:
        // Unknown escape sequence — ignore
        this.state = 'ground';
        break;
    }
  }

  // -----------------------------------------------------------------------
  // State: CSI (ESC [ ... )
  // -----------------------------------------------------------------------

  private processCsi(byte: number, char: string): void {
    // Parameter bytes: 0x30-0x39 (digits), 0x3B (;)
    if (byte >= 0x30 && byte <= 0x39) {
      this.params += char;
      return;
    }
    if (byte === 0x3B) {
      // Semicolon separates parameters — we store it in the params string
      this.params += ';';
      this.csiSeparator += ';';
      return;
    }
    if (byte === 0x3F) {
      // '?' — private mode prefix (e.g., ?25h, ?1049h)
      this.params += '?';
      return;
    }

    // Dispatch based on the final character of the CSI sequence
    this.dispatchCsiFinal(char);

    this.state = 'ground';
    this.params = '';
  }

  // -----------------------------------------------------------------------
  // State: OSC (ESC ] ... BEL or ST)
  // -----------------------------------------------------------------------

  private processOsc(byte: number, char: string): void {
    if (byte === 0x07) {
      // BEL terminates OSC
      this.handleOsc(this.params);
      this.state = 'ground';
      this.params = '';
    } else {
      this.params += char;
    }
  }

  private handleOsc(params: string): void {
    // OSC 0;title or OSC 2;title = set window title
    // Phase 1: ignore window titles
    const semicolonIdx = params.indexOf(';');
    if (semicolonIdx >= 0) {
      const code = parseInt(params.slice(0, semicolonIdx));
      if (code === 0 || code === 2) {
        const title = params.slice(semicolonIdx + 1);
        // Window title — Phase 2 passes to terminal-toolbar
      }
    }
  }

  // -----------------------------------------------------------------------
  // CSI helpers
  // -----------------------------------------------------------------------

  private getParam(index: number, defaultVal: number): number {
    const parts = this.params.split(';');
    // Filter out any '?' prefix from the first part
    const first = parts[0].replace('?', '');
    parts[0] = first;
    const val = parseInt(parts[index]);
    return isNaN(val) ? defaultVal : val;
  }

  private applySgr(): void {
    if (this.params === '' || this.params === '0') {
      this.buffer.setSgr(0);
      return;
    }

    const parts = this.params.split(';');
    for (let i = 0; i < parts.length; i += 1) {
      const code = parseInt(parts[i]);
      if (!isNaN(code)) {
        this.buffer.setSgr(code);
      }
    }
  }

  private applyMode(set: boolean): void {
    const mode = this.getParam(0, 0);

    switch (mode) {
      case 25: // Cursor visibility
        this.buffer.cursorVisible = set;
        break;
      // Alternate screen — Phase 2
      case 1049:
      case 47:
        // For now: clear screen when entering alternate screen
        if (set) {
          this.buffer.eraseDisplay(2);
        }
        break;
    }
  }

  private applyScrollRegion(): void {
    const top = this.getParam(0, 1) - 1;
    const bottom = this.getParam(1, this.buffer.rows) - 1;
    if (top < bottom && bottom < this.buffer.rows) {
      this.buffer.scrollTop = top;
      this.buffer.scrollBottom = bottom;
    }
  }

  /** Dispatch a CSI final byte to the appropriate buffer operation. */
  private dispatchCsiFinal(char: string): void {
    switch (char) {
      case 'A': this.buffer.cursorUp(this.getParam(0, 1)); break;
      case 'B': this.buffer.cursorDown(this.getParam(0, 1)); break;
      case 'C': this.buffer.cursorForward(this.getParam(0, 1)); break;
      case 'D': this.buffer.cursorBackward(this.getParam(0, 1)); break;
      case 'H': this.buffer.setCursorPosition(this.getParam(0, 1), this.getParam(1, 1)); break;
      case 'f': this.buffer.setCursorPosition(this.getParam(0, 1), this.getParam(1, 1)); break;
      case 'G': this.buffer.cursorCol = this.getParam(0, 1) - 1; break;
      case 'd': this.buffer.cursorRow = this.getParam(0, 1) - 1; break;
      case 'J': this.buffer.eraseDisplay(this.getParam(0, 0)); break;
      case 'K': this.buffer.eraseLine(this.getParam(0, 0)); break;
      case 'm': this.applySgr(); break;
      case 'h': this.applyMode(true); break;
      case 'l': this.applyMode(false); break;
      case 'r': this.applyScrollRegion(); break;
      case 'n': break; // cursor position report — ignore
      case 's': this.buffer.saveCursor(); break;
      case 'u': this.buffer.restoreCursor(); break;
      default: break; // unknown CSI final — ignore
    }
  }
}
