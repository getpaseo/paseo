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
const CSI_INPUT_MODE_SEQUENCE = new RegExp(
  `${ESC}\\[(?:([<>=?]?)([0-9;]*)u|\\?([0-9;]*)([hl]))`,
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

    CSI_INPUT_MODE_SEQUENCE.lastIndex = 0;
    for (;;) {
      const match = CSI_INPUT_MODE_SEQUENCE.exec(text);
      if (!match) {
        break;
      }
      consumedUntil = CSI_INPUT_MODE_SEQUENCE.lastIndex;

      if (match[4]) {
        changed = this.applyPrivateModeSequence(match[3] ?? "", match[4]) || changed;
        continue;
      }

      const result = this.applyKittyKeyboardSequence(match[1] ?? "", match[2] ?? "");
      changed = changed || result.changed;
      responses.push(...result.responses);
    }

    const tail = text.slice(consumedUntil);
    const pendingStart = tail.lastIndexOf(`${ESC}[`);
    if (pendingStart >= 0) {
      const pending = tail.slice(pendingStart);
      if (INCOMPLETE_CSI_INPUT_MODE_SEQUENCE.test(pending)) {
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
    return parts.join("");
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
