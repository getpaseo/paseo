import type { Terminal as TerminalType } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalReplayOptions } from "./terminal-replay.js";

/** Serialize the owned model; the PTY is a transport, not an ANSI parser oracle. */
export function createTerminalSerializer(
  terminal: TerminalType,
): (options?: TerminalReplayOptions) => Uint8Array {
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  return (options) => {
    const data = addon.serialize({ scrollback: options?.scrollbackLines });
    const buffer = terminal.buffer.active;
    // Addon 0.14 applies a horizontal offset after vertical movement has already
    // clamped a pending-wrap column, losing a column. Restore a valid position
    // absolutely; an x==cols cursor must keep its pending wrap for the next byte.
    const position =
      buffer.cursorX < terminal.cols ? `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H` : "";
    return Buffer.from(data + position + serializeCursorPresentation(terminal), "utf8");
  };
}

// Stable addon 0.14 serializes buffer/modes but omits DECSCUSR and cursor visibility.
// xterm 6 keeps the program-selected presentation in coreService, not public options.
function serializeCursorPresentation(terminal: TerminalType): string {
  const core = (
    terminal as unknown as {
      _core: {
        coreService: {
          isCursorHidden: boolean;
          decPrivateModes: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean };
        };
      };
    }
  )._core.coreService;
  const visibility = `\x1b[?25${core.isCursorHidden ? "l" : "h"}`;
  const cursorStyle = core.decPrivateModes.cursorStyle;
  // Unset presentation belongs to each renderer's configured defaults.
  if (cursorStyle === undefined) return visibility;
  const style = { block: 2, underline: 4, bar: 6 }[cursorStyle];
  return `${visibility}\x1b[${style - (core.decPrivateModes.cursorBlink ? 1 : 0)} q`;
}
