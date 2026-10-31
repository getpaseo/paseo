import xterm from "@xterm/headless";
import type { TerminalState } from "@getpaseo/protocol/messages";
import type { LocalTerminalSession } from "../terminal.js";

/** Observe the public ANSI replay using a real receiver; no production cell extraction API. */
export async function readTerminalState(session: LocalTerminalSession): Promise<TerminalState> {
  const { metadata, data } = session.serializeReplay();
  const terminal = new xterm.Terminal({
    rows: metadata.rows,
    cols: metadata.cols,
    scrollback: 10000,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    const rows = Array.from({ length: buffer.length }, (_, row) =>
      Array.from({ length: terminal.cols }, (_cell, col) => {
        const cell = buffer.getLine(row)!.getCell(col)!;
        const fgMode = cell.getFgColorMode() >> 24;
        const bgMode = cell.getBgColorMode() >> 24;
        return {
          char: cell.getWidth() === 0 ? "" : cell.getChars() || " ",
          fg: fgMode ? cell.getFgColor() : undefined,
          bg: bgMode ? cell.getBgColor() : undefined,
          fgMode: fgMode || undefined,
          bgMode: bgMode || undefined,
          bold: !!cell.isBold(),
          italic: !!cell.isItalic(),
          underline: !!cell.isUnderline(),
          dim: !!cell.isDim(),
          inverse: !!cell.isInverse(),
          strikethrough: !!cell.isStrikethrough(),
        };
      }),
    );
    const wrapped = rows.map((_, i) => buffer.getLine(i + 1)?.isWrapped === true);
    return {
      rows: terminal.rows,
      cols: terminal.cols,
      grid: rows.slice(buffer.baseY),
      scrollback: rows.slice(0, buffer.baseY),
      gridWrapped: wrapped.slice(buffer.baseY),
      scrollbackWrapped: wrapped.slice(0, buffer.baseY),
      cursor: { row: buffer.cursorY, col: buffer.cursorX },
      ...(session.getTitle() ? { title: session.getTitle() } : {}),
    };
  } finally {
    terminal.dispose();
  }
}
