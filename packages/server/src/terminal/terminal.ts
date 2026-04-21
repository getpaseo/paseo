import * as pty from "node-pty";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import stripAnsi from "strip-ansi";
import type { TerminalCell, TerminalState } from "../shared/messages.js";

const { Terminal } = xterm;
const require = createRequire(import.meta.url);
let nodePtySpawnHelperChecked = false;
const TERMINAL_TITLE_DEBOUNCE_MS = 150;
const TERMINAL_EXIT_OUTPUT_LINE_LIMIT = 12;
const TERMINAL_EXIT_OUTPUT_CHAR_LIMIT = 16000;

export interface TerminalExitInfo {
  exitCode: number | null;
  signal: number | null;
  lastOutputLines: string[];
}

export interface TerminalCommandFinishedInfo {
  exitCode: number | null;
}

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "mouse"; row: number; col: number; button: number; action: "down" | "up" | "move" };

export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "snapshot"; state: TerminalState }
  | { type: "titleChange"; title?: string };

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  send(msg: ClientMessage): void;
  subscribe(listener: (msg: ServerMessage) => void): () => void;
  onExit(listener: (info: TerminalExitInfo) => void): () => void;
  onCommandFinished(listener: (info: TerminalCommandFinishedInfo) => void): () => void;
  onTitleChange(listener: (title?: string) => void): () => void;
  getSize(): { rows: number; cols: number };
  getState(): TerminalState;
  getTitle(): string | undefined;
  getExitInfo(): TerminalExitInfo | null;
  kill(): void;
  killAndWait(options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number }): Promise<void>;
}

function parseCommandFinishedOsc(data: string): TerminalCommandFinishedInfo | null {
  // OSC 633 is terminal control traffic, but a foreground command can still
  // print arbitrary control bytes. Keep this boundary to the exact VS Code
  // command-finished shape emitted by our shell integration.
  const parts = data.split(";");
  if (parts[0] !== "D") {
    return null;
  }
  if (parts.length === 1) {
    return { exitCode: null };
  }
  if (parts.length !== 2 || !/^-?\d+$/.test(parts[1])) {
    return null;
  }
  return { exitCode: Number(parts[1]) };
}

export interface CreateTerminalOptions {
  id?: string;
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  name?: string;
  title?: string;
  command?: string;
  args?: string[];
}

interface BuildTerminalEnvironmentInput {
  shell: string;
  env: Record<string, string>;
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
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    return env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  }

  return env.SHELL || "/bin/sh";
}

export function resolveZshShellIntegrationDir(): string {
  return fileURLToPath(new URL("./shell-integration/zsh", import.meta.url));
}

export function buildTerminalEnvironment(
  input: BuildTerminalEnvironmentInput,
): Record<string, string> {
  const baseEnv: Record<string, string> = {
    ...process.env,
    ...input.env,
    TERM: "xterm-256color",
  };

  if (basename(input.shell) !== "zsh") {
    return baseEnv;
  }

  const originalZdotdir = baseEnv.ZDOTDIR ?? "";
  return {
    ...baseEnv,
    PASEO_ZSH_ZDOTDIR: originalZdotdir,
    ZDOTDIR: resolveZshShellIntegrationDir(),
  };
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

function normalizeProcessToken(token: string): string {
  if (token.length === 0) {
    return token;
  }

  const quote =
    token.startsWith('"') && token.endsWith('"')
      ? '"'
      : token.startsWith("'") && token.endsWith("'")
        ? "'"
        : "";
  const rawToken = quote ? token.slice(1, -1) : token;
  if (rawToken.length === 0) {
    return token;
  }

  const assignmentMatch = rawToken.match(/^([A-Za-z_][A-Za-z0-9_]*=)(.+)$/);
  const prefix = assignmentMatch ? assignmentMatch[1] : "";
  const value = assignmentMatch ? assignmentMatch[2] : rawToken;
  if (!value.includes("/")) {
    return token;
  }

  const normalized = `${prefix}${basename(value)}`;
  return quote ? `${quote}${normalized}${quote}` : normalized;
}

export function normalizeProcessTitle(processTitle: string): string | undefined {
  const trimmed = processTitle.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0) {
    return undefined;
  }

  const normalized = trimmed
    .split(" ")
    .map((token) => normalizeProcessToken(token))
    .join(" ")
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

const PROCESS_INTERPRETERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "nodejs",
  "python",
  "python3",
  "ruby",
  "sh",
  "tsx",
  "zsh",
]);

const PACKAGE_MANAGER_SCRIPT_NAMES = new Map<string, string>([
  ["bun.js", "bun"],
  ["npm-cli.js", "npm"],
  ["npx-cli.js", "npx"],
  ["pnpm.cjs", "pnpm"],
  ["pnpm.js", "pnpm"],
  ["yarn.cjs", "yarn"],
  ["yarn.js", "yarn"],
]);

export function humanizeProcessTitle(processTitle: string): string | undefined {
  const normalized = normalizeProcessTitle(processTitle);
  if (!normalized) {
    return undefined;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

  while (tokens[0] === "env") {
    tokens.shift();
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
  }

  if (tokens.length === 0) {
    return normalized;
  }

  const first = tokens[0];
  const second = tokens[1];
  if (PROCESS_INTERPRETERS.has(first) && second) {
    const packageManager = PACKAGE_MANAGER_SCRIPT_NAMES.get(second);
    if (packageManager) {
      return [packageManager, ...tokens.slice(2)].join(" ").trim() || packageManager;
    }

    if (!second.startsWith("-")) {
      return [second, ...tokens.slice(2)].join(" ").trim();
    }
  }

  return normalized;
}

function extractLastOutputLines(terminal: TerminalType, limit: number): string[] {
  const buffer = terminal.buffer.active;
  const mergedLines: string[] = [];

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    const isWrapped = (line as { isWrapped?: boolean }).isWrapped === true;
    if (isWrapped && mergedLines.length > 0) {
      mergedLines[mergedLines.length - 1] += text;
      continue;
    }
    mergedLines.push(text);
  }

  while (mergedLines.length > 0 && mergedLines[0]?.trim().length === 0) {
    mergedLines.shift();
  }
  while (mergedLines.length > 0 && mergedLines[mergedLines.length - 1]?.trim().length === 0) {
    mergedLines.pop();
  }

  return mergedLines.slice(-limit);
}

function stripAnsiSequences(input: string): string {
  return input.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\))/g, "");
}

function extractLastOutputLinesFromText(text: string, limit: number): string[] {
  const normalized = stripAnsiSequences(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").map((line) => line.trimEnd());
  while (lines[0]?.trim().length === 0) {
    lines.shift();
  }
  while (lines[lines.length - 1]?.trim().length === 0) {
    lines.pop();
  }
  return lines.slice(-limit);
}

function cellsToPlainText(cells: TerminalCell[], options: { stripAnsi: boolean }): string {
  const text = cells
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
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
    title: presetTitle,
    command,
    args = [],
  } = options;
  const resolvedShell = shell ?? resolveDefaultTerminalShell();

  const id = options.id ?? randomUUID();
  const listeners = new Set<(msg: ServerMessage) => void>();
  const exitListeners = new Set<(info: TerminalExitInfo) => void>();
  const commandFinishedListeners = new Set<(info: TerminalCommandFinishedInfo) => void>();
  const titleChangeListeners = new Set<(title?: string) => void>();
  let killed = false;
  let disposed = false;
  let exitEmitted = false;
  let processExited = false;
  const processExitWaiters = new Set<() => void>();
  let exitInfo: TerminalExitInfo | null = null;
  let recentOutputText = "";
  let title: string | undefined;
  let pendingTitle: string | undefined;
  let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Create xterm.js headless terminal
  const terminal = new Terminal({
    rows,
    cols,
    scrollback: 1000,
    allowProposedApi: true,
  });

  ensureNodePtySpawnHelperExecutableForCurrentPlatform();

  // Create PTY
  const spawnCommand = command ?? resolvedShell;
  const spawnArgs = command ? args : [];
  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: buildTerminalEnvironment({ shell: spawnCommand, env }),
  });

  function emitTitleChange(nextTitle: string | undefined): void {
    if (title === nextTitle) {
      return;
    }
    title = nextTitle;
    for (const listener of Array.from(titleChangeListeners)) {
      try {
        listener(title);
      } catch {
        // no-op
      }
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener({ type: "titleChange", title });
      } catch {
        // no-op
      }
    }
  }

  const lockedTitle = presetTitle?.trim() || undefined;
  const processTitle = command ? [command, ...args].join(" ") : null;
  let initialTitle = lockedTitle;
  if (!initialTitle && processTitle) {
    initialTitle = humanizeProcessTitle(processTitle) ?? normalizeProcessTitle(processTitle);
  }
  emitTitleChange(initialTitle);

  // Respond to DA1 queries (CSI c or CSI 0 c) — apps like nvim query terminal capabilities
  terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
    if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
      ptyProcess.write("\x1b[?62;4;22c");
      return true;
    }
    return false;
  });

  let disposeTitleChangeSubscription: { dispose(): void } | null = null;
  if (!lockedTitle) {
    disposeTitleChangeSubscription = terminal.onTitleChange((nextTitle) => {
      if (disposed || killed) {
        return;
      }
      pendingTitle = nextTitle.trim().length > 0 ? nextTitle : undefined;
      if (titleDebounceTimer) {
        clearTimeout(titleDebounceTimer);
      }
      titleDebounceTimer = setTimeout(() => {
        titleDebounceTimer = null;
        emitTitleChange(pendingTitle);
      }, TERMINAL_TITLE_DEBOUNCE_MS);
    });
  }

  const disposeCommandLifecycleSubscription = terminal.parser.registerOscHandler(633, (data) => {
    const commandFinished = parseCommandFinishedOsc(data);
    if (!commandFinished) {
      return true;
    }

    for (const listener of Array.from(commandFinishedListeners)) {
      try {
        listener(commandFinished);
      } catch {
        // no-op
      }
    }
    return true;
  });

  function buildExitInfo(input?: {
    exitCode?: number | null;
    signal?: number | null;
  }): TerminalExitInfo {
    const lastOutputLines = extractLastOutputLines(terminal, TERMINAL_EXIT_OUTPUT_LINE_LIMIT);
    return {
      exitCode: input?.exitCode ?? null,
      signal: input?.signal && input.signal > 0 ? input.signal : null,
      lastOutputLines:
        lastOutputLines.length > 0
          ? lastOutputLines
          : extractLastOutputLinesFromText(recentOutputText, TERMINAL_EXIT_OUTPUT_LINE_LIMIT),
    };
  }

  function emitExit(info: TerminalExitInfo): void {
    if (exitEmitted) {
      return;
    }
    exitEmitted = true;
    exitInfo = info;
    for (const listener of Array.from(exitListeners)) {
      try {
        listener(info);
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
    if (titleDebounceTimer) {
      clearTimeout(titleDebounceTimer);
      titleDebounceTimer = null;
    }
    disposeTitleChangeSubscription?.dispose();
    disposeCommandLifecycleSubscription.dispose();
    terminal.dispose();
    listeners.clear();
    exitListeners.clear();
    commandFinishedListeners.clear();
    titleChangeListeners.clear();
  }

  // Pipe PTY output to terminal emulator
  ptyProcess.onData((data) => {
    if (killed) return;
    recentOutputText = `${recentOutputText}${data}`;
    if (recentOutputText.length > TERMINAL_EXIT_OUTPUT_CHAR_LIMIT) {
      recentOutputText = recentOutputText.slice(-TERMINAL_EXIT_OUTPUT_CHAR_LIMIT);
    }
    terminal.write(data, () => {
      if (disposed || killed) {
        return;
      }
      for (const listener of listeners) {
        listener({ type: "output", data });
      }
    });
  });

  ptyProcess.onExit((event) => {
    killed = true;
    processExited = true;
    for (const waiter of Array.from(processExitWaiters)) {
      try {
        waiter();
      } catch {
        // no-op
      }
    }
    processExitWaiters.clear();
    emitExit(
      buildExitInfo({
        exitCode: event.exitCode,
        signal: event.signal,
      }),
    );
    disposeResources();
  });

  function getState(): TerminalState {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
      grid: extractGrid(terminal),
      scrollback: extractScrollback(terminal),
      cursor: extractCursorState(terminal),
      ...(title ? { title } : {}),
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

  function onExit(listener: (info: TerminalExitInfo) => void): () => void {
    if (killed) {
      queueMicrotask(() => {
        try {
          listener(exitInfo ?? buildExitInfo());
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

  function onCommandFinished(listener: (info: TerminalCommandFinishedInfo) => void): () => void {
    commandFinishedListeners.add(listener);
    return () => {
      commandFinishedListeners.delete(listener);
    };
  }

  function onTitleChange(listener: (title?: string) => void): () => void {
    titleChangeListeners.add(listener);
    if (title !== undefined) {
      queueMicrotask(() => {
        if (disposed || !titleChangeListeners.has(listener)) {
          return;
        }
        try {
          listener(title);
        } catch {
          // no-op
        }
      });
    }
    return () => {
      titleChangeListeners.delete(listener);
    };
  }

  function getTitle(): string | undefined {
    return title;
  }

  function getExitInfo(): TerminalExitInfo | null {
    return exitInfo;
  }

  function kill(): void {
    if (!killed) {
      killed = true;
      ptyProcess.kill();
      emitExit(buildExitInfo());
    }
    disposeResources();
  }

  function waitForProcessExit(timeoutMs: number): Promise<boolean> {
    if (processExited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        processExitWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      processExitWaiters.add(waiter);
    });
  }

  async function killAndWait(options?: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  }): Promise<void> {
    const gracefulTimeoutMs = options?.gracefulTimeoutMs ?? 2000;
    const forceTimeoutMs = options?.forceTimeoutMs ?? 1000;

    if (processExited) {
      kill();
      return;
    }

    try {
      ptyProcess.kill();
    } catch {
      // process may already be gone
    }

    const exitedGracefully = await waitForProcessExit(gracefulTimeoutMs);
    if (!exitedGracefully) {
      try {
        ptyProcess.kill("SIGKILL");
      } catch {
        // process may already be gone
      }
      await waitForProcessExit(forceTimeoutMs);
    }

    // Finalize bookkeeping (idempotent if ptyProcess.onExit already fired).
    kill();
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
    onCommandFinished,
    onTitleChange,
    getSize,
    getState,
    getTitle,
    getExitInfo,
    kill,
    killAndWait,
  };
}
