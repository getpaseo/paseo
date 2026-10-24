export interface TerminalInputModeFeedResult {
  changed: boolean;
  responses: string[];
}

export interface TerminalInputModeState {
  kittyKeyboardFlags: number;
  win32InputMode: boolean;
  applicationCursorKeys?: boolean;
  bracketedPaste?: boolean;
}

export interface TerminalMousePosition {
  col: number;
  row: number;
  pixelX: number;
  pixelY: number;
}

export interface TerminalWheelInput extends TerminalMousePosition {
  direction: "up" | "down";
}

export const DEFAULT_TERMINAL_INPUT_MODE_STATE: TerminalInputModeState = {
  kittyKeyboardFlags: 0,
  win32InputMode: false,
  applicationCursorKeys: false,
  bracketedPaste: false,
};

const ESC = String.fromCharCode(0x1b);
const APPLICATION_CURSOR_KEYS_MODE = 1;
const WIN32_INPUT_MODE = 9001;
const BRACKETED_PASTE_MODE = 2004;
const X10_MOUSE_TRACKING_MODE = 9;
const MOUSE_TRACKING_MODES = new Set([X10_MOUSE_TRACKING_MODE, 1000, 1002, 1003]);
const SGR_MOUSE_ENCODING_MODE = 1006;
const SGR_PIXELS_MOUSE_ENCODING_MODE = 1016;
const MOUSE_ENCODING_MODES = new Set([SGR_MOUSE_ENCODING_MODE, SGR_PIXELS_MOUSE_ENCODING_MODE]);
const LEFT_BUTTON = 0;
const DEFAULT_RELEASE_BUTTON = 3;
const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;
const DEFAULT_MOUSE_ENCODING_OFFSET = 32;
const MAX_ASCII_CODE = 127;
const FULL_RESET = `${ESC}c`;
const INPUT_MODE_SEQUENCE = new RegExp(
  `${ESC}(?:c|\\[(?:([<>=?]?)([0-9;]*)u|\\?([0-9;]*)([hl])))`,
  "g",
);
const INCOMPLETE_CSI_INPUT_MODE_SEQUENCE = new RegExp(`${ESC}\\[[<>=?]?[0-9;]*$`);

function parseFirstParam(params: string): number | null {
  const first = params.split(";")[0];
  if (!first || !/^\d+$/.test(first)) {
    return null;
  }
  return Number(first);
}

function parseSecondParam(params: string): number | null {
  const second = params.split(";")[1];
  if (!second || !/^\d+$/.test(second)) {
    return null;
  }
  return Number(second);
}

function parsePrivateModeParams(params: string): Set<number> {
  const modes = new Set<number>();
  for (const param of params.split(";")) {
    if (/^\d+$/.test(param)) {
      modes.add(Number(param));
    }
  }
  return modes;
}

export function terminalInputModeSupportsModifiedEnter(state: TerminalInputModeState): boolean {
  return state.kittyKeyboardFlags > 0 || state.win32InputMode;
}

export function terminalInputModeStatesEqual(
  left: TerminalInputModeState,
  right: TerminalInputModeState,
): boolean {
  return (
    left.kittyKeyboardFlags === right.kittyKeyboardFlags &&
    left.win32InputMode === right.win32InputMode &&
    Boolean(left.applicationCursorKeys) === Boolean(right.applicationCursorKeys) &&
    Boolean(left.bracketedPaste) === Boolean(right.bracketedPaste)
  );
}

export class TerminalInputModeTracker {
  private kittyKeyboardFlags = 0;
  private win32InputMode = false;
  private applicationCursorKeys = false;
  private bracketedPaste = false;
  private mouseTrackingMode = 0;
  private mouseEncodingMode = 0;
  private readonly kittyKeyboardStack: number[] = [];
  private pending = "";

  feed(data: string): TerminalInputModeFeedResult {
    if (data.length === 0) {
      return { changed: false, responses: [] };
    }

    const text = `${this.pending}${data}`;
    this.pending = "";

    let changed = false;
    const responses: string[] = [];
    let consumedUntil = 0;

    INPUT_MODE_SEQUENCE.lastIndex = 0;
    for (;;) {
      const match = INPUT_MODE_SEQUENCE.exec(text);
      if (!match) {
        break;
      }
      consumedUntil = INPUT_MODE_SEQUENCE.lastIndex;

      if (match[0] === FULL_RESET) {
        changed = this.getPreamble().length > 0 || changed;
        this.reset();
        continue;
      }

      if (match[4]) {
        changed = this.applyPrivateModeSequence(match[3] ?? "", match[4]) || changed;
        continue;
      }

      const result = this.applyKittyKeyboardSequence(match[1] ?? "", match[2] ?? "");
      changed = changed || result.changed;
      responses.push(...result.responses);
    }

    const tail = text.slice(consumedUntil);
    const pendingStart = tail.lastIndexOf(ESC);
    if (pendingStart >= 0) {
      const pending = tail.slice(pendingStart);
      if (pending === ESC || INCOMPLETE_CSI_INPUT_MODE_SEQUENCE.test(pending)) {
        this.pending = pending;
      }
    }

    return { changed, responses };
  }

  reset(): void {
    this.kittyKeyboardFlags = 0;
    this.win32InputMode = false;
    this.applicationCursorKeys = false;
    this.bracketedPaste = false;
    this.mouseTrackingMode = 0;
    this.mouseEncodingMode = 0;
    this.kittyKeyboardStack.length = 0;
    this.pending = "";
  }

  getState(): TerminalInputModeState {
    return {
      kittyKeyboardFlags: this.kittyKeyboardFlags,
      win32InputMode: this.win32InputMode,
      applicationCursorKeys: this.applicationCursorKeys,
      bracketedPaste: this.bracketedPaste,
    };
  }

  getKittyKeyboardFlags(): number {
    return this.kittyKeyboardFlags;
  }

  supportsModifiedEnter(): boolean {
    return terminalInputModeSupportsModifiedEnter(this.getState());
  }

  getPreamble(): string {
    const parts: string[] = [];
    if (this.kittyKeyboardFlags > 0) {
      parts.push(`\x1b[=${this.kittyKeyboardFlags};1u`);
    }
    if (this.win32InputMode) {
      parts.push("\x1b[?9001h");
    }
    if (this.applicationCursorKeys) {
      parts.push("\x1b[?1h");
    }
    if (this.bracketedPaste) {
      parts.push("\x1b[?2004h");
    }
    // The alternate screen is never replayed here: re-entering it would clear the restored screen.
    if (this.mouseTrackingMode > 0) {
      parts.push(`\x1b[?${this.mouseTrackingMode}h`);
    }
    if (this.mouseEncodingMode > 0) {
      parts.push(`\x1b[?${this.mouseEncodingMode}h`);
    }
    return parts.join("");
  }

  /** Returns the wheel report the foreground app requested, or null when it does not track the wheel. */
  encodeWheel(input: TerminalWheelInput): string | null {
    const isWheelReported =
      this.mouseTrackingMode > 0 && this.mouseTrackingMode !== X10_MOUSE_TRACKING_MODE;
    if (!isWheelReported) {
      return null;
    }
    const button = input.direction === "up" ? WHEEL_UP_BUTTON : WHEEL_DOWN_BUTTON;
    return this.encodeMouseReport(button, input, "M");
  }

  /** Returns a left press and release, press only under X10, or null when the app does not track the mouse. */
  encodeLeftClick(position: TerminalMousePosition): string | null {
    if (this.mouseTrackingMode === 0) {
      return null;
    }
    const press = this.encodeMouseReport(LEFT_BUTTON, position, "M");
    if (press === null || this.mouseTrackingMode === X10_MOUSE_TRACKING_MODE) {
      return press;
    }
    const isSgr = this.mouseEncodingMode !== 0;
    const release = isSgr
      ? this.encodeMouseReport(LEFT_BUTTON, position, "m")
      : this.encodeMouseReport(DEFAULT_RELEASE_BUTTON, position, "M");
    return release === null ? null : `${press}${release}`;
  }

  private encodeMouseReport(
    button: number,
    position: TerminalMousePosition,
    sgrFinal: "M" | "m",
  ): string | null {
    if (this.mouseEncodingMode === SGR_PIXELS_MOUSE_ENCODING_MODE) {
      return `\x1b[<${button};${position.pixelX};${position.pixelY}${sgrFinal}`;
    }
    if (this.mouseEncodingMode === SGR_MOUSE_ENCODING_MODE) {
      return `\x1b[<${button};${position.col};${position.row}${sgrFinal}`;
    }
    // Input travels as UTF-8 text, so a default-encoded byte above ASCII would be re-encoded.
    const codes = [button, position.col, position.row].map(
      (value) => value + DEFAULT_MOUSE_ENCODING_OFFSET,
    );
    if (codes.some((code) => code > MAX_ASCII_CODE)) {
      return null;
    }
    return `\x1b[M${String.fromCharCode(...codes)}`;
  }

  private applyKittyKeyboardSequence(
    prefix: string,
    params: string,
  ): { changed: boolean; responses: string[] } {
    const previousFlags = this.kittyKeyboardFlags;

    switch (prefix) {
      case ">": {
        this.kittyKeyboardStack.push(this.kittyKeyboardFlags);
        this.kittyKeyboardFlags = parseFirstParam(params) ?? 1;
        break;
      }
      case "=": {
        const mode = parseSecondParam(params) ?? 1;
        this.kittyKeyboardFlags = mode === 0 ? 0 : (parseFirstParam(params) ?? 0);
        break;
      }
      case "<": {
        const count = Math.max(1, parseFirstParam(params) ?? 1);
        for (let index = 0; index < count; index += 1) {
          this.kittyKeyboardFlags = this.kittyKeyboardStack.pop() ?? 0;
        }
        break;
      }
      case "?":
        return {
          changed: false,
          responses: [`\x1b[?${this.kittyKeyboardFlags}u`],
        };
      default:
        return { changed: false, responses: [] };
    }

    return {
      changed: this.kittyKeyboardFlags !== previousFlags,
      responses: [],
    };
  }

  private applyPrivateModeSequence(params: string, final: string): boolean {
    const modes = parsePrivateModeParams(params);
    let changed = false;

    for (const mode of modes) {
      const next = final === "h" ? mode : 0;
      if (MOUSE_TRACKING_MODES.has(mode)) {
        changed = this.mouseTrackingMode !== next || changed;
        this.mouseTrackingMode = next;
      }
      if (MOUSE_ENCODING_MODES.has(mode)) {
        changed = this.mouseEncodingMode !== next || changed;
        this.mouseEncodingMode = next;
      }
    }

    if (modes.has(WIN32_INPUT_MODE)) {
      const previous = this.win32InputMode;
      this.win32InputMode = final === "h";
      changed = this.win32InputMode !== previous || changed;
    }

    if (modes.has(APPLICATION_CURSOR_KEYS_MODE)) {
      const previous = this.applicationCursorKeys;
      this.applicationCursorKeys = final === "h";
      changed = this.applicationCursorKeys !== previous || changed;
    }

    if (modes.has(BRACKETED_PASTE_MODE)) {
      const previous = this.bracketedPaste;
      this.bracketedPaste = final === "h";
      changed = this.bracketedPaste !== previous || changed;
    }

    return changed;
  }
}
