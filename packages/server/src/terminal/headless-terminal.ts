import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import xterm, { type Terminal } from "@xterm/headless";

export interface HeadlessTerminalOptions {
  rows: number;
  cols: number;
  scrollback?: number;
}

/**
 * A headless xterm that measures text the way Paseo clients render it.
 *
 * Grapheme-cluster widths give every emoji cluster (VS16, skin-tone, flags,
 * ZWJ sequences) one two-column cell, matching color-emoji fonts. Clients
 * replay this buffer's ANSI with the same table, so cells and the cursor line
 * up after reconnect. See docs/terminal-rendering.md.
 */
export function createHeadlessTerminal(options: HeadlessTerminalOptions): Terminal {
  const terminal = new xterm.Terminal({ ...options, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  return terminal;
}
