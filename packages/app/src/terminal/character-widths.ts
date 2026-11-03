/**
 * The table a terminal buffer measures characters with.
 *
 * The daemon answers cursor reports and replays the screen from its own buffer,
 * so the app measures with the table the host advertises. `graphemes` gives each
 * emoji cluster one two-column cell. `legacy` is what each renderer used before
 * hosts advertised grapheme widths. See docs/terminal-rendering.md.
 */
export type TerminalCharacterWidths = "graphemes" | "legacy";
