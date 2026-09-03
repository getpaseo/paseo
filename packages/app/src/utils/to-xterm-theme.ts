import type { ITheme } from "@xterm/xterm";

import type { Theme } from "@/styles/theme";
import type { TerminalFindColors } from "@/terminal/runtime/terminal-emulator-runtime";

type TerminalPalette = Theme["colors"]["terminal"];

export function toXtermTheme(terminal: TerminalPalette): ITheme {
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

/**
 * Find highlight colors travel with the xterm theme so both are derived from one memo
 * over the same palette, and a theme switch can never update one without the other.
 */
export function toXtermFindColors(terminal: TerminalPalette): TerminalFindColors {
  return {
    match: terminal.findMatch,
    activeMatch: terminal.findMatchActive,
  };
}
