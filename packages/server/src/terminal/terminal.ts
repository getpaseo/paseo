import * as pty from "node-pty";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const { Terminal } = xterm;
const require = createRequire(import.meta.url);
let nodePtySpawnHelperChecked = false;

export interface Cell {
  char: string;
  fg: number | undefined;
  bg: number | undefined;
  fgMode?: number; // 0=default, 1=16 ANSI, 2=256, 3=RGB
  bgMode?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Pos {
  row: number;
  col: number;
}

export interface TerminalState {
  rows: number;
  cols: number;
  grid: Cell[][];
  scrollback: Cell[][];
  cursor: Pos;
}

export interface CellChange {
  row: number;
  col: number;
  cell: Cell;
}

export interface TerminalRawChunk {
  data: string;
  startOffset: number;
  endOffset: number;
  replay: boolean;
}

export interface TerminalRawSubscriptionResult {
  unsubscribe: () => void;
  replayedFrom: number;
  currentOffset: number;
  earliestAvailableOffset: number;
  reset: boolean;
}

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "mouse"; row: number; col: number; button: number; action: "down" | "up" | "move" };

export type ServerMessage =
  | { type: "full"; state: TerminalState }
  | { type: "diff"; changes: CellChange[]; cursor: Pos };

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  send(msg: ClientMessage): void;
  subscribe(listener: (msg: ServerMessage) => void): () => void;
  onExit(listener: () => void): () => void;
  subscribeRaw(
    listener: (chunk: TerminalRawChunk) => void,
    options?: { fromOffset?: number }
  ): TerminalRawSubscriptionResult;
  getOutputOffset(): number;
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
  options: EnsureNodePtySpawnHelperExecutableOptions = {}
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

function extractCell(terminal: TerminalType, row: number, col: number): Cell {
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
  };
}

function extractGrid(terminal: TerminalType): Cell[][] {
  const grid: Cell[][] = [];
  const buffer = terminal.buffer.active;
  // Visible viewport starts at baseY
  const baseY = buffer.baseY;

  for (let row = 0; row < terminal.rows; row++) {
    const rowCells: Cell[] = [];
    for (let col = 0; col < terminal.cols; col++) {
      rowCells.push(extractCell(terminal, baseY + row, col));
    }
    grid.push(rowCells);
  }

  return grid;
}

function extractScrollback(terminal: TerminalType): Cell[][] {
  const scrollback: Cell[][] = [];
  const buffer = terminal.buffer.active;
  // baseY is the first row of the visible viewport (0-indexed)
  // Lines 0 to baseY-1 are in scrollback, lines baseY onwards are visible
  const scrollbackLines = buffer.baseY;

  for (let row = 0; row < scrollbackLines; row++) {
    const rowCells: Cell[] = [];
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

export async function createTerminal(options: CreateTerminalOptions): Promise<TerminalSession> {
  const {
    cwd,
    shell = process.env.SHELL || "/bin/sh",
    env = {},
    rows = 24,
    cols = 80,
    name = "Terminal",
  } = options;

  const id = randomUUID();
  const listeners = new Set<(msg: ServerMessage) => void>();
  const rawListeners = new Set<(chunk: TerminalRawChunk) => void>();
  const exitListeners = new Set<() => void>();
  const rawOutputChunks: Array<{
    startOffset: number;
    endOffset: number;
    data: string;
  }> = [];
  const maxRawBufferBytes = 8 * 1024 * 1024;
  let rawBufferBytes = 0;
  let outputOffset = 0;
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
  const ptyProcess = pty.spawn(shell, [], {
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
    rawListeners.clear();
    exitListeners.clear();
  }

  function appendRawOutputChunk(data: string): void {
    const chunkBytes = Buffer.byteLength(data);
    if (chunkBytes <= 0) {
      return;
    }

    const startOffset = outputOffset;
    const endOffset = startOffset + chunkBytes;
    outputOffset = endOffset;

    rawOutputChunks.push({
      startOffset,
      endOffset,
      data,
    });
    rawBufferBytes += chunkBytes;

    while (rawBufferBytes > maxRawBufferBytes && rawOutputChunks.length > 0) {
      const removed = rawOutputChunks.shift();
      if (!removed) {
        break;
      }
      rawBufferBytes -= removed.endOffset - removed.startOffset;
    }

    const chunk: TerminalRawChunk = {
      data,
      startOffset,
      endOffset,
      replay: false,
    };
    for (const listener of rawListeners) {
      listener(chunk);
    }
  }

  function getEarliestAvailableOffset(): number {
    const earliest = rawOutputChunks[0];
    return earliest ? earliest.startOffset : outputOffset;
  }

  function alignOffsetToChunkBoundary(offset: number): number {
    if (offset === outputOffset) {
      return offset;
    }
    for (const chunk of rawOutputChunks) {
      if (offset === chunk.startOffset || offset === chunk.endOffset) {
        return offset;
      }
      if (offset > chunk.startOffset && offset < chunk.endOffset) {
        return chunk.startOffset;
      }
    }
    return offset;
  }

  // Pipe PTY output to terminal emulator
  ptyProcess.onData((data) => {
    if (killed) return;
    appendRawOutputChunk(data);
    terminal.write(data, () => {
      // Notify listeners of changes
      const state = getState();
      for (const listener of listeners) {
        listener({ type: "full", state });
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
      cursor: {
        row: terminal.buffer.active.cursorY,
        col: terminal.buffer.active.cursorX,
      },
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

    // Send initial full state
    queueMicrotask(() => {
      if (listeners.has(listener)) {
        listener({ type: "full", state: getState() });
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

  function subscribeRaw(
    listener: (chunk: TerminalRawChunk) => void,
    options?: { fromOffset?: number }
  ): TerminalRawSubscriptionResult {
    const requestedOffset = Math.max(0, Math.floor(options?.fromOffset ?? 0));
    const earliestAvailableOffset = getEarliestAvailableOffset();
    const clampedOffset = Math.max(requestedOffset, earliestAvailableOffset);
    const replayedFrom = alignOffsetToChunkBoundary(clampedOffset);
    const reset = replayedFrom !== requestedOffset;

    for (const chunk of rawOutputChunks) {
      if (chunk.endOffset <= replayedFrom) {
        continue;
      }
      listener({
        data: chunk.data,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        replay: true,
      });
    }

    rawListeners.add(listener);

    return {
      unsubscribe: () => {
        rawListeners.delete(listener);
      },
      replayedFrom,
      currentOffset: outputOffset,
      earliestAvailableOffset,
      reset,
    };
  }

  function getOutputOffset(): number {
    return outputOffset;
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
      subscribeRaw,
      getOutputOffset,
      getState,
      kill,
  };
}
