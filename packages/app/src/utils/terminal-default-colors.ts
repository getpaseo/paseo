import type { TerminalDefaultColors } from "@getpaseo/protocol/messages";
import { UnistylesRuntime } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

type TerminalThemeColors = Pick<
  Theme["colors"]["terminal"],
  "foreground" | "background" | "cursor"
>;

export function terminalDefaultColorsFromTheme(
  terminal: TerminalThemeColors,
): TerminalDefaultColors {
  return {
    foreground: terminal.foreground,
    background: terminal.background,
    cursor: terminal.cursor,
  };
}

/**
 * Read the active terminal palette at the creation action boundary so a newly
 * created PTY gets matching OSC 10/11/12, DSR 996/997, and COLORFGBG values
 * from its first byte on desktop, web, and mobile.
 */
export function getActiveTerminalDefaultColors(): TerminalDefaultColors {
  return terminalDefaultColorsFromTheme(UnistylesRuntime.getTheme().colors.terminal);
}

export function terminalDefaultColorsKey(colors: TerminalDefaultColors): string {
  return `${colors.foreground}|${colors.background}|${colors.cursor ?? ""}`;
}
