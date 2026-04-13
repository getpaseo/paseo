export interface TerminalKeyInput {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

function modifierParam(input: TerminalKeyInput): number {
  let value = 1;
  if (input.shift) value += 1;
  if (input.alt) value += 2;
  if (input.ctrl) value += 4;
  if (input.meta) value += 8;
  return value;
}

function applyAltLikePrefix(sequence: string, input: TerminalKeyInput): string {
  return input.alt ? `\x1b${sequence}` : sequence;
}

function encodePrintableKey(input: TerminalKeyInput): string {
  const raw = input.key;
  const char = input.shift ? raw.toUpperCase() : raw;

  if (input.ctrl) {
    const upper = char.toUpperCase();
    if (upper.length === 1 && upper >= "A" && upper <= "Z") {
      return applyAltLikePrefix(String.fromCharCode(upper.charCodeAt(0) - 64), input);
    }
    switch (char) {
      case " ":
      case "@":
      case "2":
        return applyAltLikePrefix("\x00", input);
      case "[":
      case "3":
        return applyAltLikePrefix("\x1b", input);
      case "\\":
      case "4":
        return applyAltLikePrefix("\x1c", input);
      case "]":
      case "5":
        return applyAltLikePrefix("\x1d", input);
      case "^":
      case "6":
        return applyAltLikePrefix("\x1e", input);
      case "_":
      case "/":
      case "7":
        return applyAltLikePrefix("\x1f", input);
      case "8":
      case "?":
        return applyAltLikePrefix("\x7f", input);
      default:
        break;
    }

    if (char.length === 1) {
      const code = char.charCodeAt(0) & 0x1f;
      return applyAltLikePrefix(String.fromCharCode(code), input);
    }
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

export function encodeTerminalKeyInput(input: TerminalKeyInput): string {
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
      if (mod > 1) {
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
      return "";
  }
}
