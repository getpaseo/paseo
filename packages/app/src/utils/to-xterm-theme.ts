import type { ITheme } from "@xterm/xterm";

import type { Theme } from "@/styles/theme";

type TerminalPalette = Theme["colors"]["terminal"];

// Callers feed the result into props whose effects key on object identity (the WebView emulator
// re-sends `setTheme` when the object changes), so equal palettes must map to the same object.
let cachedPalette: TerminalPalette | null = null;
let cachedTheme: ITheme | null = null;

function isSamePalette(a: TerminalPalette, b: TerminalPalette): boolean {
  if (a === b) {
    return true;
  }
  for (const key of Object.keys(a) as Array<keyof TerminalPalette>) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function toXtermTheme(terminal: TerminalPalette): ITheme {
  if (cachedPalette && cachedTheme && isSamePalette(cachedPalette, terminal)) {
    return cachedTheme;
  }
  cachedPalette = { ...terminal };
  cachedTheme = buildXtermTheme(terminal);
  return cachedTheme;
}

function buildXtermTheme(terminal: TerminalPalette): ITheme {
  return {
    background: terminal.background,
    foreground: terminal.foreground,
    cursor: terminal.cursor,
    cursorAccent: terminal.cursorAccent,
    selectionBackground: terminal.selectionBackground,
    selectionForeground: terminal.selectionForeground,
    black: terminal.black,
    red: terminal.red,
    green: terminal.green,
    yellow: terminal.yellow,
    blue: terminal.blue,
    magenta: terminal.magenta,
    cyan: terminal.cyan,
    white: terminal.white,

    brightBlack: terminal.brightBlack,
    brightRed: terminal.brightRed,
    brightGreen: terminal.brightGreen,
    brightYellow: terminal.brightYellow,
    brightBlue: terminal.brightBlue,
    brightMagenta: terminal.brightMagenta,
    brightCyan: terminal.brightCyan,
    brightWhite: terminal.brightWhite,
  };
}
