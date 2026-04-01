import * as pty from "node-pty";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import stripAnsi from "strip-ansi";
import type { TerminalCell, TerminalState } from "../shared/messages.js";

const { Terminal } = xterm;
const require = createRequire(import.meta.url);
let nodePtySpawnHelperChecked = false;

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "mouse"; row: number; col: number; button: number; action: "down" | "up" | "move" };

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "snapshot"; state: TerminalState };

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  send(msg: ClientMessage): void;
  subscribe(listener: (msg: ServerMessage) => void): () => void;
  onExit(listener: () => void): () => void;
  getSize(): { rows: number; cols: number };
  getState(): TerminalState;
  kill(): void;
}

export interface CreateTerminalOptions {
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  name?: string;
}

export interface CaptureTerminalLinesOptions {
  start?: number;
  end?: number;
  stripAnsi?: boolean;
}

export interface CaptureTerminalLinesResult {
  lines: string[];
  totalLines: number;
}

type EnsureNodePtySpawnHelperExecutableOptions = {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  force?: boolean;
};

function resolveNodePtyPackageRoot(): string | null {
  try {
    const packageJsonPath = require.resolve("node-pty/package.json");
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}

function ensureExecutableBit(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    return;
  }
  // node-pty 1.1.0 shipped darwin prebuild spawn-helper without execute bit.
  if ((stat.mode & 0o111) === 0o111) {
    return;
  }
  chmodSync(path, stat.mode | 0o111);
}

export function ensureNodePtySpawnHelperExecutableForCurrentPlatform(
  options: EnsureNodePtySpawnHelperExecutableOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return;
  }
  if (nodePtySpawnHelperChecked && !options.force) {
    return;
  }

  const packageRoot = options.packageRoot ?? resolveNodePtyPackageRoot();
  if (!packageRoot) {
    return;
  }
  const arch = options.arch ?? process.arch;

  const candidates = [
    join(packageRoot, "build", "Release", "spawn-helper"),
    join(packageRoot, "build", "Debug", "spawn-helper"),
    join(packageRoot, "prebuilds", `darwin-${arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    try {
      ensureExecutableBit(candidate);
    } catch {
      // best-effort hardening only
    }
  }

  if (!options.force) {
    nodePtySpawnHelperChecked = true;
  }
}

export function resolveDefaultTerminalShell(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    return env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  }

  return env.SHELL || "/bin/sh";
}

function extractCell(terminal: TerminalType, row: number, col: number): TerminalCell {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(row);
  if (!line) {
    return { char: " ", fg: undefined, bg: undefined };
  }

  const cell = line.getCell(col);
  if (!cell) {
    return { char: " ", fg: undefined, bg: undefined };
  }

  // Color modes from xterm.js: 0=DEFAULT, 1=16 colors (ANSI), 2=256 colors, 3=RGB
  // getFgColorMode() returns packed value with mode in upper byte (e.g. 0x01000000 for mode 1)
  const fgModeRaw = cell.getFgColorMode();
  const bgModeRaw = cell.getBgColorMode();
  const fgMode = fgModeRaw >> 24;
  const bgMode = bgModeRaw >> 24;

  // Only return color if not default (mode 0)
  const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
  const bg = bgMode !== 0 ? cell.getBgColor() : undefined;

  return {
    char: cell.getChars() || " ",
    fg,
    bg,
    fgMode: fgMode !== 0 ? fgMode : undefined,
    bgMode: bgMode !== 0 ? bgMode : undefined,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

function extractGrid(terminal: TerminalType): TerminalCell[][] {
  const grid: TerminalCell[][] = [];
  const buffer = terminal.buffer.active;
  // Visible viewport starts at baseY
  const baseY = buffer.baseY;

  for (let row = 0; row < terminal.rows; row++) {
    const rowCells: TerminalCell[] = [];
    for (let col = 0; col < terminal.cols; col++) {
      rowCells.push(extractCell(terminal, baseY + row, col));
    }
    grid.push(rowCells);
  }

  return grid;
}

function extractScrollback(terminal: TerminalType): TerminalCell[][] {
  const scrollback: TerminalCell[][] = [];
  const buffer = terminal.buffer.active;
  // baseY is the first row of the visible viewport (0-indexed)
  // Lines 0 to baseY-1 are in scrollback, lines baseY onwards are visible
  const scrollbackLines = buffer.baseY;

  for (let row = 0; row < scrollbackLines; row++) {
    const rowCells: TerminalCell[] = [];
    const line = buffer.getLine(row);
    for (let col = 0; col < terminal.cols; col++) {
      if (line) {
        const cell = line.getCell(col);
        if (cell) {
          const fgModeRaw = cell.getFgColorMode();
          const bgModeRaw = cell.getBgColorMode();
          const fgMode = fgModeRaw >> 24;
          const bgMode = bgModeRaw >> 24;
          const fg = fgMode !== 0 ? cell.getFgColor() : undefined;
          const bg = bgMode !== 0 ? cell.getBgColor() : undefined;
          rowCells.push({
            char: cell.getChars() || " ",
            fg,
            bg,
            fgMode: fgMode !== 0 ? fgMode : undefined,
            bgMode: bgMode !== 0 ? bgMode : undefined,
            bold: cell.isBold() !== 0,
            italic: cell.isItalic() !== 0,
            underline: cell.isUnderline() !== 0,
            dim: cell.isDim() !== 0,
            inverse: cell.isInverse() !== 0,
            strikethrough: cell.isStrikethrough() !== 0,
          });
        } else {
          rowCells.push({ char: " ", fg: undefined, bg: undefined });
        }
      } else {
        rowCells.push({ char: " ", fg: undefined, bg: undefined });
      }
    }
    scrollback.push(rowCells);
  }

  return scrollback;
}

function extractCursorState(terminal: TerminalType): TerminalState["cursor"] {
  const coreService = (terminal as any)._core?.coreService;
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
    row: terminal.buffer.active.cursorY,
    col: terminal.buffer.active.cursorX,
    ...(hidden ? { hidden: true } : {}),
    ...(normalizedCursorStyle ? { style: normalizedCursorStyle } : {}),
    ...(typeof cursorBlink === "boolean" ? { blink: cursorBlink } : {}),
  };
}

function cellsToPlainText(cells: TerminalCell[], options: { stripAnsi: boolean }): string {
  const text = cells.map((cell) => cell.char).join("").trimEnd();
  return options.stripAnsi ? stripAnsi(text) : text;
}

function resolveCaptureLineIndex(
  lineNumber: number | undefined,
  totalLines: number,
  fallback: "start" | "end",
): number {
  if (totalLines === 0) {
    return fallback === "start" ? 0 : -1;
  }

  const defaultIndex = fallback === "start" ? 0 : totalLines - 1;
  if (typeof lineNumber !== "number") {
    return defaultIndex;
  }

  const resolvedIndex = lineNumber < 0 ? totalLines + lineNumber : lineNumber;
  if (resolvedIndex < 0) {
    return 0;
  }
  if (resolvedIndex >= totalLines) {
    return totalLines - 1;
  }
  return resolvedIndex;
}

export function captureTerminalLines(
  terminal: TerminalSession,
  options: CaptureTerminalLinesOptions = {},
): CaptureTerminalLinesResult {
  const state = terminal.getState();
  const allLines = [...state.scrollback, ...state.grid].map((cells) =>
    cellsToPlainText(cells, { stripAnsi: options.stripAnsi ?? true }),
  );
  const totalLines = allLines.length;
  const startIndex = resolveCaptureLineIndex(options.start, totalLines, "start");
  const endIndex = resolveCaptureLineIndex(options.end, totalLines, "end");

  if (totalLines === 0 || startIndex > endIndex) {
    return {
      lines: [],
      totalLines,
    };
  }

  return {
    lines: allLines.slice(startIndex, endIndex + 1),
    totalLines,
  };
}

export async function createTerminal(options: CreateTerminalOptions): Promise<TerminalSession> {
  const {
    cwd,
    shell,
    env = {},
    rows = 24,
    cols = 80,
    name = "Terminal",
  } = options;
  const resolvedShell = shell ?? resolveDefaultTerminalShell();

  const id = randomUUID();
  const listeners = new Set<(msg: ServerMessage) => void>();
  const exitListeners = new Set<() => void>();
  let killed = false;
  let disposed = false;
  let exitEmitted = false;

  // Create xterm.js headless terminal
  const terminal = new Terminal({
    rows,
    cols,
    scrollback: 1000,
    allowProposedApi: true,
  });

  ensureNodePtySpawnHelperExecutableForCurrentPlatform();

  // Create PTY
  const ptyProcess = pty.spawn(resolvedShell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      ...env,
      TERM: "xterm-256color",
    },
  });

  // Respond to DA1 queries (CSI c or CSI 0 c) — apps like nvim query terminal capabilities
  terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      ptyProcess.write("\x1b[?62;4;22c");
      return true;
    }
    return false;
  });

  function emitExit(): void {
    if (exitEmitted) {
      return;
    }
    exitEmitted = true;
    for (const listener of Array.from(exitListeners)) {
      try {
        listener();
      } catch {
        // no-op
      }
    }
    exitListeners.clear();
  }

  function disposeResources(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    terminal.dispose();
    listeners.clear();
    exitListeners.clear();
  }

  // Pipe PTY output to terminal emulator
  ptyProcess.onData((data) => {
    if (killed) return;
    terminal.write(data, () => {
      if (disposed || killed) {
        return;
      }
      for (const listener of listeners) {
        listener({ type: "output", data });
      }
    });
  });

  ptyProcess.onExit(() => {
    killed = true;
    emitExit();
    disposeResources();
  });

  function getState(): TerminalState {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
      grid: extractGrid(terminal),
      scrollback: extractScrollback(terminal),
      cursor: extractCursorState(terminal),
    };
  }

  function getSize(): { rows: number; cols: number } {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
    };
  }

  function send(msg: ClientMessage): void {
    if (killed) return;

    switch (msg.type) {
      case "input":
        ptyProcess.write(msg.data);
        break;
      case "resize":
        terminal.resize(msg.cols, msg.rows);
        ptyProcess.resize(msg.cols, msg.rows);
        break;
      case "mouse":
        // Mouse events can be sent as escape sequences if terminal supports it
        // For now, we'll just ignore them - can be implemented later
        break;
    }
  }

  function subscribe(listener: (msg: ServerMessage) => void): () => void {
    listeners.add(listener);

    terminal.write("", () => {
      if (!disposed && listeners.has(listener)) {
        listener({ type: "snapshot", state: getState() });
      }
    });

    return () => {
      listeners.delete(listener);
    };
  }

  function onExit(listener: () => void): () => void {
    if (killed) {
      queueMicrotask(() => {
        try {
          listener();
        } catch {
          // no-op
        }
      });
      return () => {};
    }

    exitListeners.add(listener);
    return () => {
      exitListeners.delete(listener);
    };
  }

  function kill(): void {
    if (!killed) {
      killed = true;
      ptyProcess.kill();
      emitExit();
    }
    disposeResources();
  }

  // Small delay to let shell initialize
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    id,
    name,
    cwd,
    send,
    subscribe,
    onExit,
    getSize,
    getState,
    kill,
  };
}
