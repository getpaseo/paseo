import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { Terminal as ClientTerminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import { renderTerminalSnapshotToAnsi } from "./terminal-snapshot";

interface SnapshotCell {
  char: string;
  fg: number | undefined;
  bg: number | undefined;
  fgMode?: number;
  bgMode?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface SnapshotState {
  rows: number;
  cols: number;
  grid: SnapshotCell[][];
  scrollback: SnapshotCell[][];
  cursor: {
    row: number;
    col: number;
    hidden?: boolean;
    style?: "block" | "underline" | "bar";
    blink?: boolean;
  };
}

async function writeToTerminal(
  terminal: Pick<ClientTerminal | HeadlessTerminal, "write">,
  text: string,
): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(text, () => resolve());
  });
}

function extractState(terminal: ClientTerminal | HeadlessTerminal): SnapshotState {
  const grid: SnapshotCell[][] = [];
  const scrollback: SnapshotCell[][] = [];
  const buffer = terminal.buffer.active;
  const baseY = buffer.baseY;

  for (let row = 0; row < baseY; row += 1) {
    scrollback.push(extractRow(terminal, row));
  }
  for (let row = 0; row < terminal.rows; row += 1) {
    grid.push(extractRow(terminal, baseY + row));
  }

  return {
    rows: terminal.rows,
    cols: terminal.cols,
    grid,
    scrollback,
    cursor: extractCursorState(terminal),
  };
}

function extractCursorState(terminal: ClientTerminal | HeadlessTerminal): SnapshotState["cursor"] {
  const buffer = terminal.buffer.active;
  const coreService = (
    terminal as unknown as {
      _core?: {
        coreService?: {
          decPrivateModes?: { cursorStyle?: string; cursorBlink?: boolean };
          isCursorHidden?: boolean;
        };
      };
    }
  )._core?.coreService;
  const cursorStyle = coreService?.decPrivateModes?.cursorStyle;
  const normalizedCursorStyle =
    cursorStyle === "block" || cursorStyle === "underline" || cursorStyle === "bar"
      ? cursorStyle
      : undefined;
  const cursorBlink =
    typeof coreService?.decPrivateModes?.cursorBlink === "boolean"
      ? coreService.decPrivateModes.cursorBlink
      : undefined;
  const hidden = Boolean(coreService?.isCursorHidden);

  return {
    row: buffer.cursorY,
    col: buffer.cursorX,
    ...(hidden ? { hidden: true } : {}),
    ...(normalizedCursorStyle ? { style: normalizedCursorStyle } : {}),
    ...(typeof cursorBlink === "boolean" ? { blink: cursorBlink } : {}),
  };
}

function extractRow(terminal: ClientTerminal | HeadlessTerminal, row: number): SnapshotCell[] {
  const cells: SnapshotCell[] = [];
  const line = terminal.buffer.active.getLine(row);

  for (let col = 0; col < terminal.cols; col += 1) {
    const cell = line?.getCell(col);
    if (!cell) {
      cells.push({ char: " ", fg: undefined, bg: undefined });
      continue;
    }
    const fgModeRaw = cell.getFgColorMode();
    const bgModeRaw = cell.getBgColorMode();
    const fgMode = fgModeRaw >> 24;
    const bgMode = bgModeRaw >> 24;
    cells.push({
      char: cell.getChars() || " ",
      fg: fgMode !== 0 ? cell.getFgColor() : undefined,
      bg: bgMode !== 0 ? cell.getBgColor() : undefined,
      fgMode: fgMode !== 0 ? fgMode : undefined,
      bgMode: bgMode !== 0 ? bgMode : undefined,
      bold: cell.isBold() !== 0,
      italic: cell.isItalic() !== 0,
      underline: cell.isUnderline() !== 0,
    });
  }

  return cells;
}

describe("terminal-snapshot", () => {
  it("replays extracted terminal state into a client xterm with matching grid, scrollback, and cursor presentation", async () => {
    const source = new HeadlessTerminal({
      rows: 4,
      cols: 12,
      allowProposedApi: true,
      scrollback: 100,
    });

    await writeToTerminal(source, "plain\r\n");
    await writeToTerminal(source, "\u001b[31mred\u001b[0m\r\n");
    await writeToTerminal(source, "\u001b[1mbold\u001b[0m\r\n");
    await writeToTerminal(source, "cursor");
    await writeToTerminal(source, "\u001b[2D");
    await writeToTerminal(source, "\u001b[2 q");
    await writeToTerminal(source, "\u001b[?25l");

    const snapshot = extractState(source);

    const client = new ClientTerminal({
      rows: snapshot.rows,
      cols: snapshot.cols,
      allowProposedApi: true,
      scrollback: 100,
    });

    await writeToTerminal(client, renderTerminalSnapshotToAnsi(snapshot));

    expect(extractState(client)).toEqual(snapshot);
  });

  it("puts an alternate-screen snapshot back on the alternate screen after a reset", async () => {
    // A restore repaints the snapshot behind a RIS, which also drops the alternate
    // screen. Painted into the normal buffer instead, the program's next repaints
    // reach scrollback: the wheel ends up scrolling stale frames of a live TUI.
    const source = new HeadlessTerminal({
      rows: 3,
      cols: 10,
      allowProposedApi: true,
      scrollback: 100,
    });
    await writeToTerminal(source, "\u001b[?1049hTUI frame");

    const snapshot = {
      ...extractState(source),
      alternateScreen: source.buffer.active.type === "alternate",
    };

    const client = new ClientTerminal({
      rows: snapshot.rows,
      cols: snapshot.cols,
      allowProposedApi: true,
      scrollback: 100,
    });
    await writeToTerminal(client, "\u001bc" + renderTerminalSnapshotToAnsi(snapshot));

    expect(client.buffer.active.type).toBe("alternate");
    expect(client.buffer.active.baseY).toBe(0);
    expect(
      extractRow(client, 0)
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    ).toBe("TUI frame");
  });

  it("leaves a normal-screen snapshot in the normal buffer", async () => {
    const source = new HeadlessTerminal({ rows: 2, cols: 8, allowProposedApi: true });
    await writeToTerminal(source, "shell prompt");

    const client = new ClientTerminal({
      rows: 2,
      cols: 8,
      allowProposedApi: true,
      scrollback: 100,
    });
    await writeToTerminal(client, "\u001bc" + renderTerminalSnapshotToAnsi(extractState(source)));

    expect(client.buffer.active.type).toBe("normal");
  });
});
