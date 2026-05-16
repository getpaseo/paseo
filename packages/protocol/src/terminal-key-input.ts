import type { TerminalInputModeState } from "./terminal-input-mode.js";

export interface TerminalKeyInput {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface TerminalKeyInputEncodingOptions {
  inputMode?: TerminalInputModeState;
}

const WIN32_LEFT_ALT_PRESSED = 0x0002;
const WIN32_LEFT_CTRL_PRESSED = 0x0008;
const WIN32_SHIFT_PRESSED = 0x0010;

function modifierParam(input: TerminalKeyInput): number {
  let value = 1;
  if (input.shift) value += 1;
  if (input.alt) value += 2;
  if (input.ctrl) value += 4;
  if (input.meta) value += 8;
  return value;
}

function win32ControlKeyState(input: TerminalKeyInput): number {
  let value = 0;
  if (input.shift) value += WIN32_SHIFT_PRESSED;
  if (input.ctrl) value += WIN32_LEFT_CTRL_PRESSED;
  if (input.alt) value += WIN32_LEFT_ALT_PRESSED;
  return value;
}

function shouldUseWin32InputMode(
  input: TerminalKeyInput,
  options: TerminalKeyInputEncodingOptions,
): boolean {
  if (!options.inputMode?.win32InputMode) {
    return false;
  }
  return Boolean(input.shift || input.ctrl || input.alt);
}

function shouldUseKittyKeyboardMode(
  input: TerminalKeyInput,
  options: TerminalKeyInputEncodingOptions,
): boolean {
  if ((options.inputMode?.kittyKeyboardFlags ?? 0) <= 0) {
    return false;
  }
  return Boolean(input.shift || input.ctrl || input.alt || input.meta);
}

function encodeWin32EnterKeyInput(input: TerminalKeyInput): string {
  const controlKeyState = win32ControlKeyState(input);
  // ConPTY Win32 input mode: CSI Vk;Sc;Uc;Kd;Cs;Rc _
  return `\x1b[13;28;13;1;${controlKeyState};1_`;
}

function applyAltLikePrefix(sequence: string, input: TerminalKeyInput): string {
  return input.alt ? `\x1b${sequence}` : sequence;
}

function ctrlSymbolCode(char: string): string | null {
  switch (char) {
    case " ":
    case "@":
    case "2":
      return "\x00";
    case "[":
    case "3":
      return "\x1b";
    case "\\":
    case "4":
      return "\x1c";
    case "]":
    case "5":
      return "\x1d";
    case "^":
    case "6":
      return "\x1e";
    case "_":
    case "/":
    case "7":
      return "\x1f";
    case "8":
    case "?":
      return "\x7f";
    default:
      return null;
  }
}

function encodeCtrlChar(char: string, input: TerminalKeyInput): string {
  const upper = char.toUpperCase();
  if (upper.length === 1 && upper >= "A" && upper <= "Z") {
    return applyAltLikePrefix(String.fromCharCode(upper.charCodeAt(0) - 64), input);
  }
  const symbol = ctrlSymbolCode(char);
  if (symbol !== null) {
    return applyAltLikePrefix(symbol, input);
  }
  if (char.length === 1) {
    const code = char.charCodeAt(0) & 0x1f;
    return applyAltLikePrefix(String.fromCharCode(code), input);
  }
  return applyAltLikePrefix(char, input);
}

function encodePrintableKey(input: TerminalKeyInput): string {
  const raw = input.key;
  const char = input.shift ? raw.toUpperCase() : raw;

  if (input.ctrl) {
    return encodeCtrlChar(char, input);
  }

  return applyAltLikePrefix(char, input);
}

function csiWithModifier(finalByte: string, input: TerminalKeyInput): string {
  const mod = modifierParam(input);
  return mod === 1 ? `\x1b[${finalByte}` : `\x1b[1;${mod}${finalByte}`;
}

function csiTilde(base: number, input: TerminalKeyInput): string {
  const mod = modifierParam(input);
  return mod === 1 ? `\x1b[${base}~` : `\x1b[${base};${mod}~`;
}

function encodeFunctionKey(key: string, input: TerminalKeyInput): string | null {
  switch (key) {
    case "F1":
      return modifierParam(input) === 1 ? "\x1bOP" : csiWithModifier("P", input);
    case "F2":
      return modifierParam(input) === 1 ? "\x1bOQ" : csiWithModifier("Q", input);
    case "F3":
      return modifierParam(input) === 1 ? "\x1bOR" : csiWithModifier("R", input);
    case "F4":
      return modifierParam(input) === 1 ? "\x1bOS" : csiWithModifier("S", input);
    case "F5":
      return csiTilde(15, input);
    case "F6":
      return csiTilde(17, input);
    case "F7":
      return csiTilde(18, input);
    case "F8":
      return csiTilde(19, input);
    case "F9":
      return csiTilde(20, input);
    case "F10":
      return csiTilde(21, input);
    case "F11":
      return csiTilde(23, input);
    case "F12":
      return csiTilde(24, input);
    default:
      return null;
  }
}

function encodeNavigationKey(key: string, input: TerminalKeyInput): string | null {
  switch (key) {
    case "ArrowUp":
      return csiWithModifier("A", input);
    case "ArrowDown":
      return csiWithModifier("B", input);
    case "ArrowRight":
      return csiWithModifier("C", input);
    case "ArrowLeft":
      return csiWithModifier("D", input);
    case "Home":
      return csiWithModifier("H", input);
    case "End":
      return csiWithModifier("F", input);
    case "Insert":
      return csiTilde(2, input);
    case "Delete":
      return csiTilde(3, input);
    case "PageUp":
      return csiTilde(5, input);
    case "PageDown":
      return csiTilde(6, input);
    default:
      return null;
  }
}

export function encodeTerminalKeyInput(
  input: TerminalKeyInput,
  options: TerminalKeyInputEncodingOptions = {},
): string {
  const key = input.key;
  if (!key) {
    return "";
  }

  if (key.length === 1) {
    return encodePrintableKey(input);
  }

  switch (key) {
    case "Enter": {
      const mod = modifierParam(input);
      if (mod > 1 && shouldUseWin32InputMode(input, options)) {
        return encodeWin32EnterKeyInput(input);
      }
      if (mod > 1 && shouldUseKittyKeyboardMode(input, options)) {
        return `\x1b[13;${mod}u`;
      }
      return "\r";
    }
    case "Tab":
      if (input.shift && !input.ctrl && !input.alt && !input.meta) {
        return "\x1b[Z";
      }
      return applyAltLikePrefix("\t", input);
    case "Backspace":
      return applyAltLikePrefix("\x7f", input);
    case "Escape":
      return "\x1b";
    default:
      break;
  }

  const nav = encodeNavigationKey(key, input);
  if (nav !== null) return nav;
  const fn = encodeFunctionKey(key, input);
  if (fn !== null) return fn;
  return "";
}
