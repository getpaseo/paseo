import * as pty from "node-pty";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import { randomUUID } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createExternalProcessEnv } from "../server/paseo-env.js";
import { writePrivateFileAtomicSync } from "../server/private-files.js";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import type { TerminalCell, TerminalState } from "@getpaseo/protocol/messages";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";
import { TerminalActivityTracker } from "./activity/terminal-activity-tracker.js";
import type { TerminalActivity, TerminalActivityState } from "@getpaseo/protocol/terminal-activity";

const { Terminal } = xterm;
const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@getpaseo/cli/bin/paseo";
let nodePtySpawnHelperChecked = false;
const TERMINAL_TITLE_DEBOUNCE_MS = 150;
const TERMINAL_EXIT_OUTPUT_LINE_LIMIT = 12;
const TERMINAL_EXIT_OUTPUT_CHAR_LIMIT = 16000;
const TERMINAL_OSC_COLOR_QUERY_RESPONSES = new Map<number, string>([
  [10, "rgb:e6e6/e6e6/e6e6"],
  [11, "rgb:0b0b/0b0b/0b0b"],
  [12, "rgb:e6e6/e6e6/e6e6"],
]);

export interface TerminalExitInfo {
  exitCode: number | null;
  signal: number | null;
  lastOutputLines: string[];
}

export interface TerminalCommandFinishedInfo {
  exitCode: number | null;
}

export interface TerminalStateSnapshot {
  state: TerminalState;
  revision: number;
  // Input-mode replay preamble at snapshot time. Populated by the terminal
  // worker so the daemon main loop doesn't have to re-derive it from output.
  replayPreamble?: string;
}

export interface TerminalStateSnapshotOptions {
  scrollbackLines?: number;
  // Include per-row soft-wrap flags (gridWrapped/scrollbackWrapped) so the client
  // can reflow restored content on resize. Gated on a client capability, so old
  // clients never receive the extra fields.
  includeWrapFlags?: boolean;
}

export interface TerminalSubscribeOptions {
  initialSnapshot?: "state" | "ready";
}

export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "mouse"; row: number; col: number; button: number; action: "down" | "up" | "move" };

export type ServerMessage =
  | { type: "output"; data: string; revision?: number }
  | { type: "snapshot"; state: TerminalState; revision?: number }
  | { type: "snapshotReady"; revision?: number; replayPreamble?: string }
  | { type: "titleChange"; title?: string };

export interface TerminalActivityTransition {
  activity: TerminalActivity | null;
  previous: TerminalActivity | null;
}

export interface TerminalSession {
  id: string;
  name: string;
  cwd: string;
  workspaceId: string;
  send(msg: ClientMessage): void;
  subscribe(listener: (msg: ServerMessage) => void, options?: TerminalSubscribeOptions): () => void;
  onExit(listener: (info: TerminalExitInfo) => void): () => void;
  onCommandFinished(listener: (info: TerminalCommandFinishedInfo) => void): () => void;
  onTitleChange(listener: (title?: string) => void): () => void;
  onActivityChange(listener: (transition: TerminalActivityTransition) => void): () => void;
  getSize(): { rows: number; cols: number };
  getState(): TerminalState;
  getStateSnapshot(options?: TerminalStateSnapshotOptions): TerminalStateSnapshot;
  getReplayPreamble(): string;
  getTitle(): string | undefined;
  getActivity(): TerminalActivity | null;
  setActivity(state: TerminalActivityState): void;
  clearActivityAttention(): boolean;
  setTitle(title: string): void;
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
  workspaceId: string;
  shell?: string;
  env?: Record<string, string>;
  activityEnv?: Record<string, string>;
  rows?: number;
  cols?: number;
  name?: string;
  title?: string;
  command?: string;
  args?: string[];
}

function toTerminalActivity(snapshot: {
  state: TerminalActivityState | null;
  attentionReason?: TerminalActivity["attentionReason"];
  changedAt: number;
}): TerminalActivity | null {
  if (!snapshot.state) {
    return null;
  }
  return {
    state: snapshot.state,
    ...(snapshot.attentionReason ? { attentionReason: snapshot.attentionReason } : {}),
    changedAt: snapshot.changedAt,
  };
}

function resolveInitialTitleMode(presetTitle: string | undefined): "auto" | "manual" {
  return presetTitle?.trim() ? "manual" : "auto";
}

interface BuildTerminalEnvironmentInput {
  shell: string;
  env: Record<string, string>;
  zshShellIntegrationDir?: string;
  paseoCliBinDir?: string | null;
  paseoHookCliPath?: string | null;
}

interface EnsureNodePtySpawnHelperExecutableOptions {
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  force?: boolean;
}

interface WindowsPtyProcessReadiness {
  _agent?: { innerPid?: number };
}

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

export interface ResolvedTerminalCommand {
  command: string;
  args: string[];
}

export interface ResolveTerminalSpawnCommandOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  resolveExecutable?: (name: string) => Promise<string | null>;
}

/**
 * Resolve a terminal profile command (e.g. `claude`) into something node-pty's
 * conpty backend can actually launch on Windows.
 *
 * On Windows, conpty's underlying `CreateProcess` does not apply `PATHEXT`, so a
 * bare `claude` (installed by npm as `claude.cmd`) fails with `error code: 2`
 * (`ERROR_FILE_NOT_FOUND`). Worse, conpty completes the spawn asynchronously on
 * its own conout worker thread, so that failure surfaces as an uncaught
 * exception that takes down the whole terminal worker process. Resolving the
 * real path up front — and routing `.cmd`/`.bat` shims through `cmd.exe /c`
 * (node-pty has no `shell` option) — keeps the profile launchable.
 *
 * Non-Windows and the default-shell path (no explicit command) are unchanged.
 */
export async function resolveTerminalSpawnCommand(
  command: string,
  args: string[],
  options: ResolveTerminalSpawnCommandOptions = {},
): Promise<ResolvedTerminalCommand> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args };
  }

  const resolveExecutable = options.resolveExecutable ?? findExecutable;
  const resolved = await resolveExecutable(command);
  if (!resolved) {
    // Leave the command as-is so the terminal itself surfaces the "not found"
    // error to the user instead of silently doing nothing.
    return { command, args };
  }

  // `.cmd`/`.bat` shims are batch scripts that conpty's CreateProcess cannot
  // launch directly; they must run through cmd.exe (node-pty has no `shell`
  // option, so build the `cmd /c` invocation ourselves). Checked by extension
  // rather than isWindowsCommandScript() because that helper gates on the live
  // process.platform, which is wrong once we're already on the win32 branch.
  const extension = extname(resolved).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const env = options.env ?? process.env;
    const comSpec = env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
    return { command: comSpec, args: ["/c", resolved, ...args] };
  }

  return { command: resolved, args };
}

export function resolveZshShellIntegrationDir(): string {
  return fileURLToPath(new URL("./shell-integration/zsh", import.meta.url));
}

function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolvePaseoCliBinDir(): string | null {
  const cliEntrypoint = resolvePaseoCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  return findNpmBinDir(dirname(externalCliEntrypoint)) ?? dirname(externalCliEntrypoint);
}

export function resolvePaseoCliExecutablePath(): string | null {
  const cliEntrypoint = resolvePaseoCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolvePaseoCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolvePaseoCliBinEntrypoint(): string | null {
  try {
    return require.resolve(PASEO_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasPaseoCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasPaseoCliShim(binDir: string): boolean {
  return resolvePaseoCliShim(binDir) !== null;
}

function resolvePaseoCliShim(binDir: string): string | null {
  for (const name of paseoCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function paseoCliShimNames(): string[] {
  return process.platform === "win32" ? ["paseo.cmd", "paseo.exe", "paseo"] : ["paseo"];
}

function resolveZshShellIntegrationRuntimeDir(): string {
  let username = "unknown";
  try {
    username = userInfo().username || username;
  } catch {
    // keep fallback
  }
  return join(tmpdir(), `${username}-paseo-zsh`);
}

function prepareZshShellIntegrationRuntimeDir(sourceDir = resolveZshShellIntegrationDir()): string {
  const readableSourceDir = resolveExternalProcessPath(sourceDir);
  const runtimeDir = resolveZshShellIntegrationRuntimeDir();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  writePrivateFileAtomicSync(
    join(runtimeDir, ".zshenv"),
    readFileSync(join(readableSourceDir, ".zshenv")),
  );
  writePrivateFileAtomicSync(
    join(runtimeDir, "paseo-integration.zsh"),
    readFileSync(join(readableSourceDir, "paseo-integration.zsh")),
  );
  return runtimeDir;
}

export function buildTerminalEnvironment(
  input: BuildTerminalEnvironmentInput,
): Record<string, string> {
  const baseEnv: Record<string, string> = createExternalProcessEnv(process.env, input.env, {
    TERM: "xterm-256color",
    TERM_PROGRAM: "kitty",
  });
  const envWithAgentHooks = prependPaseoCliToPath(
    baseEnv,
    input.paseoCliBinDir === undefined ? resolvePaseoCliBinDir() : input.paseoCliBinDir,
  );
  const envWithHookCli = injectPaseoHookCli(
    envWithAgentHooks,
    input.paseoHookCliPath === undefined ? resolvePaseoCliExecutablePath() : input.paseoHookCliPath,
  );

  if (basename(input.shell) !== "zsh") {
    return envWithHookCli;
  }

  const originalZdotdir = envWithHookCli.ZDOTDIR ?? "";
  return {
    ...envWithHookCli,
    PASEO_ZSH_ZDOTDIR: originalZdotdir,
    ZDOTDIR: prepareZshShellIntegrationRuntimeDir(input.zshShellIntegrationDir),
  };
}

function injectPaseoHookCli(
  env: Record<string, string>,
  cliPath: string | null,
): Record<string, string> {
  if (!cliPath) {
    return env;
  }

  return {
    ...env,
    PASEO_HOOK_CLI: resolvePath(resolveExternalProcessPath(cliPath)),
  };
}

function prependPaseoCliToPath(
  env: Record<string, string>,
  cliBinDir: string | null,
): Record<string, string> {
  if (!cliBinDir) {
    return env;
  }

  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey] ?? "";
  return {
    ...env,
    [pathKey]: prependPathEntry(currentPath, cliBinDir),
  };
}

function getPathEnvKey(env: Record<string, string>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function prependPathEntry(currentPath: string, entry: string): string {
  const entries = currentPath.split(delimiter).filter((value) => value && value !== entry);
  return [entry, ...entries].join(delimiter);
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

function extractScrollback(
  terminal: TerminalType,
  options?: { scrollbackLines?: number },
): TerminalCell[][] {
  const scrollback: TerminalCell[][] = [];
  const buffer = terminal.buffer.active;
  // baseY is the first row of the visible viewport (0-indexed)
  // Lines 0 to baseY-1 are in scrollback, lines baseY onwards are visible
  const scrollbackLines = buffer.baseY;
  const startRow =
    typeof options?.scrollbackLines === "number"
      ? Math.max(0, scrollbackLines - options.scrollbackLines)
      : 0;

  for (let row = startRow; row < scrollbackLines; row++) {
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

// xterm marks a line `isWrapped` when it is a continuation of the PREVIOUS line.
// The snapshot carries the inverse, tmux-style flag — "this row continues onto the
// next row" — so the client can rejoin and reflow logical lines. So row y's flag is
// whether line y+1 is a wrapped continuation.
function lineContinuesToNext(terminal: TerminalType, absoluteRow: number): boolean {
  return terminal.buffer.active.getLine(absoluteRow + 1)?.isWrapped === true;
}

function extractGridWrapped(terminal: TerminalType): boolean[] {
  const baseY = terminal.buffer.active.baseY;
  const wrapped: boolean[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    wrapped.push(lineContinuesToNext(terminal, baseY + row));
  }
  return wrapped;
}

function extractScrollbackWrapped(
  terminal: TerminalType,
  options?: { scrollbackLines?: number },
): boolean[] {
  const scrollbackLines = terminal.buffer.active.baseY;
  const startRow =
    typeof options?.scrollbackLines === "number"
      ? Math.max(0, scrollbackLines - options.scrollbackLines)
      : 0;
  const wrapped: boolean[] = [];
  for (let row = startRow; row < scrollbackLines; row++) {
    wrapped.push(lineContinuesToNext(terminal, row));
  }
  return wrapped;
}

function extractCursorState(terminal: TerminalType): TerminalState["cursor"] {
  const coreService = (terminal as unknown as { _core?: { coreService?: Record<string, unknown> } })
    ._core?.coreService as
    | {
        decPrivateModes?: { cursorStyle?: unknown; cursorBlink?: unknown };
        isCursorHidden?: unknown;
      }
    | undefined;
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

  let quote: "'" | '"' | "";
  if (token.startsWith('"') && token.endsWith('"')) {
    quote = '"';
  } else if (token.startsWith("'") && token.endsWith("'")) {
    quote = "'";
  } else {
    quote = "";
  }
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

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\].*?(?:${BEL}|${ESC}\\\\))`,
  "g",
);

function stripAnsiSequences(input: string): string {
  return input.replace(ANSI_SEQUENCE_PATTERN, "");
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

export async function createTerminal(options: CreateTerminalOptions): Promise<TerminalSession> {
  const {
    cwd,
    workspaceId,
    shell,
    env = {},
    activityEnv = {},
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
  // Recent output is retained as whole chunks plus a running char length so we
  // avoid reallocating a ~16KB string on every pty chunk. We keep enough whole
  // chunks that their join always contains at least the last
  // TERMINAL_EXIT_OUTPUT_CHAR_LIMIT chars; the exact tail is sliced at exit.
  const recentOutputChunks: string[] = [];
  let recentOutputLength = 0;
  let title: string | undefined;
  let titleMode = resolveInitialTitleMode(presetTitle);
  let pendingTitle: string | undefined;
  let titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingInput = "";
  let inputFlushImmediate: ReturnType<typeof setImmediate> | null = null;
  let stateRevision = 0;
  const inputModeTracker = new TerminalInputModeTracker();
  const activityTracker = new TerminalActivityTracker();
  const activityChangeListeners = new Set<(transition: TerminalActivityTransition) => void>();
  let titleChangeSubscription: { dispose(): void } | null = null;

  // Create xterm.js headless terminal
  const terminal = new Terminal({
    rows,
    cols,
    scrollback: 1000,
    allowProposedApi: true,
  });

  ensureNodePtySpawnHelperExecutableForCurrentPlatform();

  // Create PTY
  const { command: spawnCommand, args: spawnArgs } = command
    ? await resolveTerminalSpawnCommand(command, args)
    : { command: resolvedShell, args: [] as string[] };
  const ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: buildTerminalEnvironment({
      shell: spawnCommand,
      env: {
        ...env,
        ...activityEnv,
        PASEO_WORKSPACE_ID: workspaceId,
      },
    }),
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

  function clearPendingTitleChange(): void {
    pendingTitle = undefined;
    if (titleDebounceTimer) {
      clearTimeout(titleDebounceTimer);
      titleDebounceTimer = null;
    }
  }

  function disposeTitleChangeSubscription(): void {
    titleChangeSubscription?.dispose();
    titleChangeSubscription = null;
  }

  function setTitle(nextTitle: string): void {
    const manualTitle = nextTitle.trim();
    if (!manualTitle) {
      return;
    }

    titleMode = "manual";
    disposeTitleChangeSubscription();
    clearPendingTitleChange();
    emitTitleChange(manualTitle);
  }

  const initialManualTitle = presetTitle?.trim() || undefined;
  const processTitle = command ? [command, ...args].join(" ") : null;
  let initialTitle = initialManualTitle;
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
  terminal.parser.registerCsiHandler({ final: "n" }, (params) => {
    if (params.length !== 1) {
      return false;
    }
    if (params[0] === 5) {
      ptyProcess.write("\x1b[0n");
      return true;
    }
    if (params[0] === 6) {
      const buffer = terminal.buffer.active;
      ptyProcess.write(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
      return true;
    }
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
    if (params.length !== 1 || params[0] !== 6) {
      return false;
    }
    const buffer = terminal.buffer.active;
    ptyProcess.write(`\x1b[?${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
    return true;
  });
  for (const [code, response] of TERMINAL_OSC_COLOR_QUERY_RESPONSES) {
    terminal.parser.registerOscHandler(code, (data) => {
      if (data.trim() !== "?") {
        return false;
      }
      ptyProcess.write(`\x1b]${code};${response}\x1b\\`);
      return true;
    });
  }

  if (titleMode === "auto") {
    titleChangeSubscription = terminal.onTitleChange((nextTitle) => {
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
        pendingTitle = undefined;
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

  activityTracker.onChange((snapshot, previousSnapshot) => {
    if (disposed || killed) {
      return;
    }
    const transition: TerminalActivityTransition = {
      activity: toTerminalActivity(snapshot),
      previous: toTerminalActivity(previousSnapshot),
    };
    for (const listener of Array.from(activityChangeListeners)) {
      try {
        listener(transition);
      } catch {
        // no-op
      }
    }
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
          : extractLastOutputLinesFromText(
              recentOutputChunks.join("").slice(-TERMINAL_EXIT_OUTPUT_CHAR_LIMIT),
              TERMINAL_EXIT_OUTPUT_LINE_LIMIT,
            ),
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
    activityTracker.clear();
    pendingInput = "";
    recentOutputChunks.length = 0;
    recentOutputLength = 0;
    inputModeTracker.reset();
    if (inputFlushImmediate) {
      clearImmediate(inputFlushImmediate);
      inputFlushImmediate = null;
    }
    clearPendingTitleChange();
    disposeTitleChangeSubscription();
    disposeCommandLifecycleSubscription.dispose();
    activityTracker.dispose();
    terminal.dispose();
    listeners.clear();
    exitListeners.clear();
    commandFinishedListeners.clear();
    titleChangeListeners.clear();
    activityChangeListeners.clear();
  }

  function writeOutputToHeadless(data: string): void {
    terminal.write(data, () => {
      if (disposed || killed) {
        return;
      }
      stateRevision += 1;
      for (const listener of listeners) {
        listener({ type: "output", data, revision: stateRevision });
      }
    });
  }

  // Pipe PTY output to terminal emulator
  ptyProcess.onData((data) => {
    if (killed) return;
    const inputModeUpdate = inputModeTracker.feed(data);
    for (const response of inputModeUpdate.responses) {
      ptyProcess.write(response);
    }
    recentOutputChunks.push(data);
    recentOutputLength += data.length;
    // Drop whole leading chunks while the rest still covers the char limit, so
    // the retained join always contains at least the last limit chars.
    while (
      recentOutputChunks.length > 1 &&
      recentOutputLength - recentOutputChunks[0].length >= TERMINAL_EXIT_OUTPUT_CHAR_LIMIT
    ) {
      recentOutputLength -= recentOutputChunks[0].length;
      recentOutputChunks.shift();
    }
    // We never drop the last chunk, so a single chunk larger than the cap would
    // grow the buffer unbounded; slice its tail to keep the cap hard.
    if (recentOutputChunks.length === 1 && recentOutputLength > TERMINAL_EXIT_OUTPUT_CHAR_LIMIT) {
      const tail = recentOutputChunks[0].slice(-TERMINAL_EXIT_OUTPUT_CHAR_LIMIT);
      recentOutputChunks[0] = tail;
      recentOutputLength = tail.length;
    }
    writeOutputToHeadless(data);
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

  async function waitForPtyProcessStart(): Promise<void> {
    if (process.platform !== "win32") {
      return;
    }

    const started = (): boolean => {
      const windowsPtyProcess = ptyProcess as unknown as WindowsPtyProcessReadiness;
      return ptyProcess.pid > 0 || (windowsPtyProcess._agent?.innerPid ?? 0) > 0 || processExited;
    };

    const deadline = Date.now() + 5000;
    while (!started() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function getState(snapshotOptions?: TerminalStateSnapshotOptions): TerminalState {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
      grid: extractGrid(terminal),
      scrollback: extractScrollback(terminal, {
        scrollbackLines: snapshotOptions?.scrollbackLines,
      }),
      cursor: extractCursorState(terminal),
      ...(title ? { title } : {}),
      ...(snapshotOptions?.includeWrapFlags
        ? {
            gridWrapped: extractGridWrapped(terminal),
            scrollbackWrapped: extractScrollbackWrapped(terminal, {
              scrollbackLines: snapshotOptions?.scrollbackLines,
            }),
          }
        : {}),
    };
  }

  function getStateSnapshot(snapshotOptions?: TerminalStateSnapshotOptions): TerminalStateSnapshot {
    return {
      state: getState(snapshotOptions),
      revision: stateRevision,
    };
  }

  function getSize(): { rows: number; cols: number } {
    return {
      rows: terminal.rows,
      cols: terminal.cols,
    };
  }

  function getReplayPreamble(): string {
    return inputModeTracker.getPreamble();
  }

  function writeInputToPty(data: string): void {
    ptyProcess.write(data);
  }

  function flushPendingInput(): void {
    if (inputFlushImmediate) {
      clearImmediate(inputFlushImmediate);
      inputFlushImmediate = null;
    }
    const data = pendingInput;
    pendingInput = "";
    if (!data || killed || disposed) {
      return;
    }
    writeInputToPty(data);
  }

  function scheduleInputFlush(): void {
    if (inputFlushImmediate) {
      return;
    }
    inputFlushImmediate = setImmediate(() => {
      inputFlushImmediate = null;
      flushPendingInput();
    });
  }

  function send(msg: ClientMessage): void {
    if (killed) return;

    switch (msg.type) {
      case "input": {
        pendingInput += msg.data;
        scheduleInputFlush();
        break;
      }
      case "resize":
        flushPendingInput();
        terminal.resize(msg.cols, msg.rows);
        ptyProcess.resize(msg.cols, msg.rows);
        stateRevision += 1;
        break;
      case "mouse":
        // Mouse events can be sent as escape sequences if terminal supports it
        // For now, we'll just ignore them - can be implemented later
        break;
    }
  }

  function subscribe(
    listener: (msg: ServerMessage) => void,
    subscribeOptions?: TerminalSubscribeOptions,
  ): () => void {
    let active = true;
    let snapshotDelivered = false;
    const queuedMessages: ServerMessage[] = [];
    const initialSnapshot = subscribeOptions?.initialSnapshot ?? "state";
    const subscriptionListener = (msg: ServerMessage): void => {
      if (!active) {
        return;
      }
      if (!snapshotDelivered) {
        queuedMessages.push(msg);
        return;
      }
      listener(msg);
    };

    listeners.add(subscriptionListener);

    terminal.write("", () => {
      if (!disposed && active && listeners.has(subscriptionListener)) {
        snapshotDelivered = true;
        if (initialSnapshot === "ready") {
          // Carry the input-mode preamble so the snapshot-less "ready" path
          // (live restore) can replay it without a separate state fetch.
          listener({
            type: "snapshotReady",
            revision: stateRevision,
            replayPreamble: getReplayPreamble(),
          });
        } else {
          listener({ type: "snapshot", ...getStateSnapshot() });
        }
        for (const message of queuedMessages.splice(0)) {
          listener(message);
        }
      }
    });

    return () => {
      active = false;
      queuedMessages.length = 0;
      listeners.delete(subscriptionListener);
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

  function onActivityChange(
    listener: (transition: TerminalActivityTransition) => void,
  ): () => void {
    activityChangeListeners.add(listener);
    return () => {
      activityChangeListeners.delete(listener);
    };
  }

  function getTitle(): string | undefined {
    return title;
  }

  function getActivity(): TerminalActivity | null {
    return toTerminalActivity(activityTracker.getSnapshot());
  }

  function setActivity(state: TerminalActivityState): void {
    activityTracker.set(state);
  }

  function clearActivityAttention(): boolean {
    return activityTracker.clearAttention();
  }

  function getExitInfo(): TerminalExitInfo | null {
    return exitInfo;
  }

  function kill(): void {
    if (!killed) {
      killed = true;
      if (!processExited) {
        killPtyProcess();
      }
      emitExit(buildExitInfo());
    }
    if (processExited) {
      disposeResources();
      return;
    }
    void waitForProcessExit(1000).finally(disposeResources);
  }

  function killPtyProcess(signal?: NodeJS.Signals): void {
    if (process.platform === "win32") {
      ptyProcess.kill();
      return;
    }
    ptyProcess.kill(signal);
  }

  function waitForProcessExit(timeoutMs: number): Promise<boolean> {
    if (processExited) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let pendingResolve: ((value: boolean) => void) | null = resolve;
      const settle = (value: boolean) => {
        if (!pendingResolve) return;
        const fn = pendingResolve;
        pendingResolve = null;
        fn(value);
      };
      const waiter = (): void => {
        clearTimeout(timer);
        settle(true);
      };
      const timer = setTimeout(() => {
        processExitWaiters.delete(waiter);
        settle(false);
      }, timeoutMs);
      processExitWaiters.add(waiter);
    });
  }

  async function killAndWait(killOptions?: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  }): Promise<void> {
    const gracefulTimeoutMs = killOptions?.gracefulTimeoutMs ?? 2000;
    const forceTimeoutMs = killOptions?.forceTimeoutMs ?? 1000;

    if (processExited) {
      kill();
      return;
    }

    try {
      killPtyProcess();
    } catch {
      // process may already be gone
    }

    const exitedGracefully = await waitForProcessExit(gracefulTimeoutMs);
    if (!exitedGracefully) {
      try {
        killPtyProcess("SIGKILL");
      } catch {
        // process may already be gone
      }
      await waitForProcessExit(forceTimeoutMs);
    }

    // Finalize bookkeeping (idempotent if ptyProcess.onExit already fired).
    kill();
  }

  await waitForPtyProcessStart();

  // Small delay to let shell initialize
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    id,
    name,
    cwd,
    workspaceId,
    send,
    subscribe,
    onExit,
    onCommandFinished,
    onTitleChange,
    onActivityChange,
    getSize,
    getState,
    getStateSnapshot,
    getReplayPreamble,
    getTitle,
    getActivity,
    setActivity,
    clearActivityAttention,
    setTitle,
    getExitInfo,
    kill,
    killAndWait,
  };
}
