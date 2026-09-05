import type { TerminalDefaultColors } from "@getpaseo/protocol/messages";
import { UnistylesRuntime } from "react-native-unistyles";

/**
 * Terminal OSC replies are fixed when the PTY is created. Read the active
 * palette at the action boundary so a terminal opened from any app surface
 * gets the same colors that its renderer will use.
 */
export function getActiveTerminalDefaultColors(): TerminalDefaultColors {
  const terminal = UnistylesRuntime.getTheme().colors.terminal;
  return {
    foreground: terminal.foreground,
    background: terminal.background,
    cursor: terminal.cursor,
  };
}
