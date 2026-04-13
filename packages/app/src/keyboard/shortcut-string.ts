import type { ShortcutKey } from "@/utils/format-shortcut";

export interface KeyCombo {
  code: string;
  key?: string;
  meta?: true;
  ctrl?: true;
  alt?: true;
  shift?: true;
  mod?: true;
  repeat?: false;
}

interface KeyMapping {
  code: string;
  key?: string;
}

const KEY_MAP: Record<string, KeyMapping> = {};

for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(65 + i);
  KEY_MAP[letter] = { code: `Key${letter}`, key: letter.toLowerCase() };
}

for (let i = 0; i <= 9; i++) {
  KEY_MAP[String(i)] = { code: `Digit${i}`, key: String(i) };
}

KEY_MAP["Digit"] = { code: "Digit" };
KEY_MAP["\\"] = { code: "Backslash" };
KEY_MAP["["] = { code: "BracketLeft", key: "[" };
KEY_MAP["]"] = { code: "BracketRight", key: "]" };
KEY_MAP[","] = { code: "Comma", key: "," };
KEY_MAP["."] = { code: "Period", key: "." };
KEY_MAP["`"] = { code: "Backquote", key: "`" };
KEY_MAP["/"] = { code: "Slash" };
KEY_MAP["?"] = { code: "Slash", key: "?" };
KEY_MAP["Space"] = { code: "Space", key: " " };
KEY_MAP["Enter"] = { code: "Enter", key: "Enter" };
KEY_MAP["Backspace"] = { code: "Backspace" };
KEY_MAP["Escape"] = { code: "Escape" };
KEY_MAP["ArrowLeft"] = { code: "ArrowLeft" };
KEY_MAP["ArrowRight"] = { code: "ArrowRight" };
KEY_MAP["ArrowUp"] = { code: "ArrowUp" };
KEY_MAP["ArrowDown"] = { code: "ArrowDown" };
KEY_MAP["Tab"] = { code: "Tab" };
KEY_MAP["Delete"] = { code: "Delete" };
KEY_MAP["Home"] = { code: "Home" };
KEY_MAP["End"] = { code: "End" };
KEY_MAP["PageUp"] = { code: "PageUp" };
KEY_MAP["PageDown"] = { code: "PageDown" };
KEY_MAP["Insert"] = { code: "Insert" };

for (let i = 1; i <= 12; i++) {
  KEY_MAP[`F${i}`] = { code: `F${i}` };
}

const CODE_TO_KEY: Record<string, string> = {};
for (const [humanKey, mapping] of Object.entries(KEY_MAP)) {
  if (!CODE_TO_KEY[mapping.code]) {
    CODE_TO_KEY[mapping.code] = humanKey;
  }
}

export function parseShortcutString(s: string): KeyCombo {
  const parts = s.split("+");
  if (parts.length === 0 || parts.some((p) => p === "")) {
    throw new Error(`Invalid shortcut string: "${s}"`);
  }

  const combo: KeyCombo = { code: "" };
  let keyPart: string | null = null;

  for (const part of parts) {
    switch (part) {
      case "Cmd":
        combo.meta = true;
        break;
      case "Ctrl":
        combo.ctrl = true;
        break;
      case "Alt":
        combo.alt = true;
        break;
      case "Shift":
        combo.shift = true;
        break;
      case "Mod":
        combo.mod = true;
        break;
      default:
        if (keyPart !== null) {
          throw new Error(`Invalid shortcut string: "${s}" - multiple key parts`);
        }
        keyPart = part;
        break;
    }
  }

  if (keyPart === null) {
    throw new Error(`Invalid shortcut string: "${s}" - no key part`);
  }

  const mapping = KEY_MAP[keyPart];
  if (!mapping) {
    throw new Error(`Unknown key: "${keyPart}"`);
  }

  combo.code = mapping.code;
  if (mapping.key !== undefined) {
    combo.key = mapping.key;
  }

  return combo;
}

export function parseChordString(s: string): KeyCombo[] {
  return s.split(" ").map(parseShortcutString);
}

export function keyComboToString(combo: KeyCombo): string {
  const parts: string[] = [];

  if (combo.mod) {
    parts.push("Mod");
  }
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  if (combo.meta) parts.push("Cmd");

  const humanKey = CODE_TO_KEY[combo.code];
  if (humanKey) {
    parts.push(humanKey);
  }

  return parts.join("+");
}

export function chordToString(chord: KeyCombo[]): string {
  return chord.map(keyComboToString).join(" ");
}

const MODIFIER_CODES = new Set([
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
]);

export function comboStringToShortcutKeys(comboString: string): ShortcutKey[] {
  const parts = comboString.split("+");
  const keys: ShortcutKey[] = [];
  for (const part of parts) {
    switch (part) {
      case "Cmd":
        keys.push("mod");
        break;
      case "Ctrl":
        keys.push("ctrl");
        break;
      case "Alt":
        keys.push("alt");
        break;
      case "Shift":
        keys.push("shift");
        break;
      default:
        keys.push(part.toUpperCase());
        break;
    }
  }
  return keys;
}

export function chordStringToShortcutKeys(s: string): ShortcutKey[][] {
  return s.split(" ").map(comboStringToShortcutKeys);
}

export function heldModifiersFromEvent(event: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Cmd");
  return parts.length > 0 ? parts.join("+") : null;
}

export function keyboardEventToComboString(event: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(event.code)) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Cmd");

  const humanKey = CODE_TO_KEY[event.code];
  if (humanKey) {
    parts.push(humanKey);
  } else {
    return null;
  }

  return parts.join("+");
}
