import { promisify } from "util";
import { constants as fsConstants, type Dirent, realpath } from "fs";
import { copyFile, mkdir, readdir, rm, stat } from "fs/promises";
import { join, basename, dirname, isAbsolute, resolve, sep } from "path";
import net from "node:net";
import { createHash } from "node:crypto";
import stripAnsi from "strip-ansi";
import pLimit from "p-limit";
import { execCommand } from "@getpaseo/plugin/server";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
  type StringCommandShellInvocation,
} from "./string-command-shell.js";
import { readPaseoConfig } from "./paseo-config-file.js";
export {
  PaseoConfigRawSchema,
  PaseoLifecycleCommandRawSchema,
  PaseoScriptEntryRawSchema,
  PaseoWorktreeConfigRawSchema,
  PaseoConfigSchema,
  type PaseoConfig,
  type PaseoConfigRaw,
} from "@getpaseo/protocol/paseo-config-schema";
import { type PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import {
  createPaseoWorktreeChangeRequestHint,
  hasPaseoWorktreeMetadata,
  findPaseoWorktreeRootForCwd,
  normalizeBaseRefName,
  isQualifiedRef,
  type PaseoWorktreeChangeRequestHint,
  readPaseoWorktreeMetadata,
  readPaseoWorktreeRuntimePort,
  writePaseoWorktreeMetadata,
  writePaseoWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runWithRepositoryRoot } from "./git-repository-discovery.js";
import { runGitCommand } from "./run-git-command.js";
import { getCurrentBranch, resolveRepositoryDefaultBranch } from "./checkout-git.js";
import { spawnProcess } from "./spawn.js";
import { applyLaunchWrap } from "./launch-wrap.js";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { createExternalProcessEnv } from "../server/paseo-env.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import {
  createRealpathAwarePathMatcher,
  expandTilde,
  getRealpathAwareRelativePath,
  getRelativePathInsideRoot,
  isPathInsideRoot,
  normalizePathForIdentity,
} from "./path.js";
import { terminateWithTreeKill } from "./tree-kill.js";
import { validateWorktreePath } from "./worktree-path.js";
import type { PluginWorktreeManagerRuntime } from "../server/plugins/runtime.js";

export { slugify, validateBranchSlug } from "@getpaseo/protocol/branch-slug";

const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export interface CreatedWorktree extends WorktreeConfig {
  comparisonBaseRef: string | null;
  worktreeManagerPluginId?: string;
}

export interface WorktreeRuntimeEnv {
  [key: string]: string;
  PASEO_SOURCE_CHECKOUT_PATH: string;
  PASEO_ROOT_PATH: string;
  PASEO_WORKTREE_PATH: string;
  PASEO_BRANCH_NAME: string;
  PASEO_WORKTREE_PORT: string;
}

export interface WorktreeSetupCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type WorktreeSetupCommandProgressEvent =
  | {
      type: "command_started";
      index: number;
      total: number;
      command: string;
      cwd: string;
    }
  | {
      type: "output";
      index: number;
      total: number;
      command: string;
      cwd: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "command_completed";
      index: number;
      total: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    };

export interface WorktreeTerminalConfig {
  name?: string;
  command: string;
}

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number; // explicit port override, otherwise auto-assigned
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
}

/** A lifecycle command, and the environment Paseo adds to the daemon's for it. */
export interface WorktreeLifecycleCommand {
  command: string;
  env: Record<string, string>;
}

/** How a lifecycle command runs after plugins saw it: its environment and an optional wrap. */
export interface PreparedWorktreeLifecycleCommand {
  env: Record<string, string>;
  wrap?: readonly [string, ...string[]];
}

/** Lets plugins wrap or refuse a lifecycle command before it runs; see `command.run.before`. */
export type PrepareWorktreeLifecycleCommand = (
  command: WorktreeLifecycleCommand,
) => Promise<PreparedWorktreeLifecycleCommand>;

/**
 * Asks the hooks how to run `command`. Resolves to `null` when `signal` aborts first, such as at the
 * teardown deadline or when archive cancels setup; the command must then not start.
 */
async function prepareLifecycleCommand(options: {
  prepare: PrepareWorktreeLifecycleCommand | undefined;
  command: WorktreeLifecycleCommand;
  signal: AbortSignal | undefined;
  fail: (message: string) => Error;
}): Promise<PreparedWorktreeLifecycleCommand | null> {
  const { prepare, command, signal } = options;
  if (signal?.aborted) return null;
  if (!prepare) return { env: command.env };
  let stopWaiting = () => {};
  const aborted = new Promise<null>((settle) => {
    const onAbort = () => settle(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    stopWaiting = () => signal?.removeEventListener("abort", onAbort);
  });
  const prepared = prepare(command).catch((error: unknown) => {
    throw options.fail(error instanceof Error ? error.message : String(error));
  });
  // A hook that settles after the abort no longer matters; keep its rejection handled.
  prepared.catch(() => {});
  try {
    return await Promise.race([prepared, aborted]);
  } finally {
    stopWaiting();
  }
}

/** The shell invocation for a `paseo.json` command, started behind a plugin's wrap when set. */
function lifecycleCommandInvocation(
  command: string,
  wrap: PreparedWorktreeLifecycleCommand["wrap"],
): StringCommandShellInvocation {
  const invocation = buildStringCommandShellInvocation({ command });
  const launch = applyLaunchWrap({ command: invocation.shell, args: invocation.args }, wrap);
  return { shell: launch.command, args: launch.args };
}

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export type WorktreeTeardownCommandResult = WorktreeSetupCommandResult;

// paseo.json can change this with worktree.teardownTimeoutMs. Archive waits for teardown before it
// answers, and the app stops waiting for an archive answer after 60 seconds
// (DEFAULT_SESSION_RPC_TIMEOUT_MS in the client). A teardown that runs to this limit, or to a longer
// one, answers after the app has reported the archive as failed.
const DEFAULT_WORKTREE_TEARDOWN_TIMEOUT_MS = 60_000;
const MAX_WORKTREE_TEARDOWN_OUTPUT_CHARS_PER_STREAM = 1024 * 1024;

export class WorktreeTeardownError extends Error {
  readonly results: WorktreeTeardownCommandResult[];

  constructor(message: string, results: WorktreeTeardownCommandResult[]) {
    super(message);
    this.name = "WorktreeTeardownError";
    this.results = results;
  }
}

export interface PaseoWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export interface PaseoWorktreeOwnership {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
}

export interface PaseoWorktreeOwnershipOptions extends WorktreeRootOptions {
  knownGitCommonDir?: string | null;
}

export interface WorktreeRootOptions {
  paseoHome?: string;
  worktreesRoot?: string;
}

export interface WorktreeCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export type WorktreeSource =
  | {
      kind: "branch-off";
      baseBranch: string;
      branchName: string;
      /** Where the new branch starts when that is not `baseBranch`, such as a fork's head. */
      startPoint?: string;
    }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "restore"; branchName: string; baseRef: string | null }
  | { kind: "restore-commit"; commit: string; baseRef: string }
  | { kind: "restore-from-base"; baseRef: string; branchName: string }
  | {
      kind: "checkout-change-request";
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      headRepository?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

export interface PreparedWorktreeBranchOff {
  baseRef: string;
  checkoutRef: string;
  branchExists: boolean;
}

export interface CreateWorktreeOptions {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  preparedBranchOff?: PreparedWorktreeBranchOff;
  paseoHome?: string;
  worktreesRoot?: string;
  worktreePath?: string;
}

export class BranchAlreadyCheckedOutError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Branch already checked out: ${branchName}`);
    this.name = "BranchAlreadyCheckedOutError";
    this.branchName = branchName;
  }
}

export class UnknownBranchError extends Error {
  readonly branchName: string;
  readonly cwd: string;

  constructor(params: { branchName: string; cwd: string }) {
    super(`Unknown branch: ${params.branchName}`);
    this.name = "UnknownBranchError";
    this.branchName = params.branchName;
    this.cwd = params.cwd;
  }
}

export class InvalidGitBranchNameError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Invalid branch name: Git rejected ref name '${branchName}'`);
    this.name = "InvalidGitBranchNameError";
    this.branchName = branchName;
  }
}

export { readPaseoConfig, type ReadPaseoConfigResult } from "./paseo-config-file.js";

export function paseoConfigParseError(failure: { configPath: string; error: unknown }): Error {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return new Error(`Failed to parse paseo.json at ${failure.configPath}: ${detail}`, {
    cause: failure.error,
  });
}

async function readPaseoConfigOrThrow(repoRoot: string): Promise<PaseoConfig | null> {
  const result = await readPaseoConfig(repoRoot);
  if (!result.ok) {
    throw paseoConfigParseError(result);
  }
  return result.config;
}

export async function getWorktreeSetupCommands(repoRoot: string): Promise<string[]> {
  return (await readPaseoConfigOrThrow(repoRoot))?.worktree?.setup ?? [];
}

export async function getWorktreeTeardownCommands(repoRoot: string): Promise<string[]> {
  return (await readPaseoConfigOrThrow(repoRoot))?.worktree?.teardown ?? [];
}

export async function getWorktreeTeardownTimeoutMs(repoRoot: string): Promise<number> {
  return (
    (await readPaseoConfigOrThrow(repoRoot))?.worktree?.teardownTimeoutMs ??
    DEFAULT_WORKTREE_TEARDOWN_TIMEOUT_MS
  );
}

export async function getWorktreeTerminalSpecs(
  repoRoot: string,
): Promise<WorktreeTerminalConfig[]> {
  const terminals = (await readPaseoConfigOrThrow(repoRoot))?.worktree?.terminals;
  if (!Array.isArray(terminals) || terminals.length === 0) {
    return [];
  }

  const specs: WorktreeTerminalConfig[] = [];
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== "object") {
      continue;
    }

    const rawCommand = terminal.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const rawName = terminal.name;
    const name =
      typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : undefined;

    specs.push({
      ...(name ? { name } : {}),
      command,
    });
  }

  return specs;
}

export function getScriptConfigs(config: PaseoConfig | null): Map<string, ScriptConfig> {
  const scripts = config?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return new Map();
  }

  const result = new Map<string, ScriptConfig>();
  for (const [name, entry] of Object.entries(scripts)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const rawCommand = entry.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const scriptConfig: ScriptConfig =
      entry.type === "service"
        ? {
            type: "service",
            command,
          }
        : { command };

    if (
      isServiceScript(scriptConfig) &&
      typeof entry.port === "number" &&
      Number.isFinite(entry.port)
    ) {
      scriptConfig.port = entry.port;
    }

    result.set(name, scriptConfig);
  }

  return result;
}

export function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }

  const output: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    output.push(line.join(""));
    line = [];
    cursor = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        flushLine();
        output.push("\n");
        index += 1;
        continue;
      }
      cursor = 0;
      continue;
    }

    if (char === "\n") {
      flushLine();
      output.push("\n");
      continue;
    }

    if (cursor < line.length) {
      line[cursor] = char;
    } else {
      line.push(char);
    }
    cursor += 1;
  }

  if (line.length > 0) {
    output.push(line.join(""));
  }

  return output.join("");
}

async function execSetupCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; wrap: PreparedWorktreeLifecycleCommand["wrap"] },
): Promise<WorktreeSetupCommandResult> {
  const startedAt = Date.now();
  const shellInvocation = lifecycleCommandInvocation(command, options.wrap);
  try {
    // execCommand starts a Windows `.cmd` or `.bat` wrap through cmd.exe; anything else has no shell.
    const { stdout, stderr } = await execCommand(shellInvocation.shell, shellInvocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });
    return {
      command,
      cwd: options.cwd,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const execErr = error as { stdout?: string; stderr?: string; code?: unknown } | undefined;
    return {
      command,
      cwd: options.cwd,
      stdout: execErr?.stdout ?? "",
      stderr: execErr?.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: typeof execErr?.code === "number" ? execErr.code : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function execSetupCommandStreamed(options: {
  command: string;
  wrap: PreparedWorktreeLifecycleCommand["wrap"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  index: number;
  total: number;
  signal?: AbortSignal;
  maxOutputCharsPerStream?: number;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const outputChunks: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
    const outputLimit = options.maxOutputCharsPerStream ?? Infinity;
    const remainingOutputChars = { stdout: outputLimit, stderr: outputLimit };
    let settled = false;
    let termination: Promise<unknown> | null = null;

    const emitOutput = (stream: "stdout" | "stderr", chunk: string) => {
      const text = stripAnsi(chunk);
      if (!text) {
        return;
      }
      const retainedText = text.slice(0, remainingOutputChars[stream]);
      if (retainedText) {
        outputChunks[stream].push(retainedText);
        remainingOutputChars[stream] -= retainedText.length;
      }
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream,
        chunk: text,
      });
    };

    const finish = async (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (termination) {
        await termination;
        // A descendant can keep these pipes open after the shell exits.
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const result: WorktreeSetupCommandResult = {
        command: options.command,
        cwd: options.cwd,
        stdout: outputChunks.stdout.join(""),
        stderr: outputChunks.stderr.join(""),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
      options.onEvent?.({
        type: "command_completed",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      resolvePromise(result);
    };

    options.onEvent?.({
      type: "command_started",
      index: options.index,
      total: options.total,
      command: options.command,
      cwd: options.cwd,
    });

    const shellInvocation = lifecycleCommandInvocation(options.command, options.wrap);
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(shellInvocation.shell, shellInvocation.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A command that cannot start fails like one whose process reports a spawn error.
      emitOutput("stderr", error instanceof Error ? error.message : String(error));
      void finish(null);
      return;
    }

    function abort(): void {
      termination ??= terminateWithTreeKill(child, {
        gracefulTimeoutMs: 1000,
        forceTimeoutMs: 1000,
      });
      void finish(null);
    }
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      emitOutput("stdout", chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      emitOutput("stderr", chunk.toString());
    });

    child.on("error", (error) => {
      emitOutput("stderr", error instanceof Error ? error.message : String(error));
      void finish(null);
    });

    child.on("close", (code) => {
      void finish(typeof code === "number" ? code : null);
    });
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire available port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      let message: string;
      if (error?.code === "EADDRINUSE") {
        message = `Persisted worktree port ${port} is already in use`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      reject(new Error(message));
    });
    server.listen(port, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  });
}

async function inferRepoRootPathFromWorktreePath(worktreePath: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(worktreePath);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    // Normal repo/worktree: common dir is <repoRoot>/.git
    if (basename(normalizedCommonDir) === ".git") {
      return dirname(normalizedCommonDir);
    }
    // Bare repo: common dir is the repo dir itself
    return normalizedCommonDir;
  } catch {
    // Fallback: best-effort resolve toplevel (will be the worktree root in typical cases)
    try {
      const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: worktreePath,
        envOverlay: READ_ONLY_GIT_ENV,
      });
      const topLevel = parseGitRevParsePath(stdout);
      if (topLevel) {
        return await normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return await normalizePathForOwnership(worktreePath);
  }
}

export async function runWorktreeSetupCommands(options: {
  worktreePath: string;
  branchName: string;
  repoRootPath?: string;
  runtimeEnv?: WorktreeRuntimeEnv;
  signal?: AbortSignal;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
  prepareCommand?: PrepareWorktreeLifecycleCommand;
}): Promise<WorktreeSetupCommandResult[]> {
  // Read paseo.json from the worktree (it will have the same content as the source repo)
  const setupCommands = await getWorktreeSetupCommands(options.worktreePath);
  if (setupCommands.length === 0) {
    return [];
  }

  const runtimeEnv =
    options.runtimeEnv ??
    (await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      ...(options.repoRootPath ? { repoRootPath: options.repoRootPath } : {}),
    }));

  const results: WorktreeSetupCommandResult[] = [];
  for (const [index, cmd] of setupCommands.entries()) {
    const prepared = await prepareLifecycleCommand({
      prepare: options.prepareCommand,
      command: { command: cmd, env: { ...runtimeEnv } },
      signal: options.signal,
      fail: (message) =>
        new WorktreeSetupError(`Worktree setup command refused: ${cmd}\n${message}`, results),
    });
    if (!prepared) {
      throw new WorktreeSetupError(`Worktree setup canceled before: ${cmd}`, results);
    }
    const setupEnv = createStringCommandShellEnv(
      createExternalProcessEnv(process.env, prepared.env),
    );
    const result = options.onEvent
      ? await execSetupCommandStreamed({
          command: cmd,
          wrap: prepared.wrap,
          cwd: options.worktreePath,
          env: setupEnv,
          index: index + 1,
          total: setupCommands.length,
          signal: options.signal,
          onEvent: options.onEvent,
        })
      : await execSetupCommand(cmd, {
          cwd: options.worktreePath,
          env: setupEnv,
          wrap: prepared.wrap,
        });
    results.push(result);

    if (result.exitCode !== 0) {
      throw new WorktreeSetupError(
        `Worktree setup command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], {
      cwd: worktreePath,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const branchName = stdout.trim();
    if (branchName.length > 0) {
      return branchName;
    }
  } catch {
    // ignore
  }

  return basename(worktreePath);
}

export async function resolveWorktreeRuntimeEnv(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeRuntimeEnv> {
  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));

  let worktreePort = await readPaseoWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = await readPaseoWorktreeMetadata(options.worktreePath);
    if (metadata) {
      await writePaseoWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    PASEO_WORKTREE_PORT: String(worktreePort),
  };
}

export async function runWorktreeTeardownCommands(options: {
  worktreePath: string;
  teardownCwd?: string;
  branchName?: string;
  repoRootPath?: string;
  prepareCommand?: PrepareWorktreeLifecycleCommand;
}): Promise<WorktreeTeardownCommandResult[]> {
  const teardownCwd = options.teardownCwd ?? options.worktreePath;
  if ((await getOwnershipRelativePath(options.worktreePath, teardownCwd)) === null) {
    throw new Error(`Worktree teardown cwd is outside the worktree: ${teardownCwd}`);
  }
  const teardownCommands = await getWorktreeTeardownCommands(teardownCwd);
  if (teardownCommands.length === 0) {
    return [];
  }

  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));
  const worktreePort = await readPaseoWorktreeRuntimePort(options.worktreePath);

  const runtimeEnv: Record<string, string> = {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows lifecycle scripts to copy or clean resources using paths
    // from the source checkout.
    PASEO_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    PASEO_ROOT_PATH: repoRootPath,
    PASEO_WORKTREE_PATH: options.worktreePath,
    PASEO_BRANCH_NAME: branchName,
    ...(worktreePort !== null ? { PASEO_WORKTREE_PORT: String(worktreePort) } : {}),
  };

  // One deadline covers every command. Reaching it counts as failure and keeps the worktree.
  const timeoutMs = await getWorktreeTeardownTimeoutMs(teardownCwd);
  const deadline = AbortSignal.timeout(timeoutMs);
  const results: WorktreeTeardownCommandResult[] = [];
  for (const [index, cmd] of teardownCommands.entries()) {
    const prepared = await prepareLifecycleCommand({
      prepare: options.prepareCommand,
      command: { command: cmd, env: { ...runtimeEnv } },
      signal: deadline,
      fail: (message) =>
        new WorktreeTeardownError(`Worktree teardown command refused: ${cmd}\n${message}`, results),
    });
    if (!prepared) {
      throw new WorktreeTeardownError(
        `Worktree teardown command failed: ${cmd}\nTimed out after ${timeoutMs / 1000}s`,
        results,
      );
    }
    const result = await execSetupCommandStreamed({
      command: cmd,
      wrap: prepared.wrap,
      cwd: teardownCwd,
      env: createStringCommandShellEnv(createExternalProcessEnv(process.env, prepared.env)),
      index: index + 1,
      total: teardownCommands.length,
      signal: deadline,
      maxOutputCharsPerStream: MAX_WORKTREE_TEARDOWN_OUTPUT_CHARS_PER_STREAM,
    });
    results.push(result);

    if (result.exitCode !== 0) {
      const reason = deadline.aborted ? `Timed out after ${timeoutMs / 1000}s` : result.stderr;
      throw new WorktreeTeardownError(
        `Worktree teardown command failed: ${cmd}\n${reason}`.trim(),
        results,
      );
    }
  }

  return results;
}

export async function seedPaseoConfigFile(options: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceConfigPath = join(options.sourceCwd, "paseo.json");
  const targetConfigPath = join(options.targetCwd, "paseo.json");
  await copyFile(sourceConfigPath, targetConfigPath, fsConstants.COPYFILE_EXCL).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  });
}

/**
 * Get the git common directory (shared across worktrees) for a given cwd.
 * This is where refs, objects, etc. are stored.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  return commonDir;
}

const WORKTREE_PROJECT_HASH_LENGTH = 8;

function deriveShortAlphanumericHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

export async function deriveWorktreeProjectHash(cwd: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(cwd);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(await normalizePathForOwnership(cwd));
  }
}

export function resolvePaseoWorktreesBaseRoot(options?: WorktreeRootOptions): string {
  if (options?.worktreesRoot) {
    const expandedRoot = expandTilde(options.worktreesRoot);
    if (isAbsolute(expandedRoot)) {
      return resolve(expandedRoot);
    }
    const home = options.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
    return resolve(home, expandedRoot);
  }

  const home = options?.paseoHome ? resolve(options.paseoHome) : resolvePaseoHome();
  return join(home, "worktrees");
}

export async function getPaseoWorktreesRoot(
  cwd: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const baseRoot = resolvePaseoWorktreesBaseRoot({ paseoHome, worktreesRoot });
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(baseRoot, projectHash);
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  paseoHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  return join(projectWorktreesRoot, slug);
}

export function mapWorkspaceCwdToWorktree(input: {
  sourceWorktreePath: string;
  workspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(
    input.sourceWorktreePath,
    input.workspaceCwd,
  );
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${input.workspaceCwd}`);
  }

  return mapWorkspaceRelativeCwdToWorktree({
    relativeWorkspaceCwd,
    targetWorktreePath: input.targetWorktreePath,
  });
}

export function mapWorkspaceRelativeCwdToWorktree(input: {
  relativeWorkspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const mappedCwd = resolve(input.targetWorktreePath, input.relativeWorkspaceCwd);
  if (!isPathInsideRoot(input.targetWorktreePath, mappedCwd)) {
    throw new Error(`Workspace cwd escapes its target worktree: ${input.relativeWorkspaceCwd}`);
  }
  return mappedCwd;
}

// Keep the former realpathSync spelling on Windows: promises.realpath uses the
// native resolver and can return an 8.3 alias instead of the long path.
const resolveOwnershipPath = promisify(realpath);
const resolveNativeOwnershipPath = promisify(realpath.native);
const ownershipIdentityIo = pLimit(2);

async function normalizePathForOwnership(input: string): Promise<string> {
  try {
    return await ownershipIdentityIo(() => resolveOwnershipPath(input));
  } catch {
    return resolve(input);
  }
}

async function ownershipPathVariants(input: string): Promise<string[]> {
  const variants = new Set([input, await normalizePathForOwnership(input)]);
  try {
    variants.add(await ownershipIdentityIo(() => resolveNativeOwnershipPath(input)));
  } catch {
    // Missing descendants still match a lexical or established root spelling.
  }
  return [...variants];
}

// Keep lexical variants for missing paths: archive must still recognize a removed
// worktree below a symlinked worktrees root, whose full realpath no longer exists.
async function getOwnershipRelativePath(root: string, candidate: string): Promise<string | null> {
  const roots = await ownershipPathVariants(root);
  const candidates = await ownershipPathVariants(candidate);
  for (const rootPath of roots) {
    for (const candidatePath of candidates) {
      const relative = getRelativePathInsideRoot(rootPath, candidatePath);
      if (relative !== null) return relative;
    }
  }
  return null;
}

async function resolveRepoRootFromGitCommonDir(commonDir: string): Promise<string> {
  const normalizedCommonDir = await normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isPaseoOwnedWorktreeCwd(
  cwd: string,
  options?: PaseoWorktreeOwnershipOptions,
): Promise<PaseoWorktreeOwnership> {
  const resolvedCwd = await normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  if (options?.knownGitCommonDir) {
    repoRoot = await resolveRepoRootFromGitCommonDir(options.knownGitCommonDir);
  } else if (options?.knownGitCommonDir === undefined) {
    try {
      const gitCommonDir = await getGitCommonDir(cwd);
      repoRoot = await resolveRepoRootFromGitCommonDir(gitCommonDir);
    } catch {
      // ignore
    }
  }

  // Worktrees placed at plugin-chosen paths are
  // proven by the marker createWorktree writes unconditionally: a
  // paseo/worktree.json in the worktree's git admin dir, with the path
  // still registered in the repo's `git worktree list`. The marker alone
  // is not proof — it lives in a git admin dir a user can copy into a
  // hand-made directory that git does not know about.
  if (options?.knownGitCommonDir !== null) {
    const metadataProof = await resolveMetadataOwnedWorktree(cwd, repoRoot);
    if (metadataProof) {
      return {
        allowed: true,
        ...(repoRoot !== undefined ? { repoRoot } : {}),
        worktreeRoot: metadataProof.worktreeRoot,
        worktreePath: metadataProof.worktreePath,
      };
    }
  }

  const worktreesBaseRoot = resolvePaseoWorktreesBaseRoot(options);
  const relativePath = await getOwnershipRelativePath(worktreesBaseRoot, resolvedCwd);

  // Ownership is defined by the path living under <worktrees-root>/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is Paseo-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (relativePath !== null) {
    const parts = relativePath.split(sep).filter((part) => part.length > 0);
    if (parts.length >= 2) {
      const worktreesRoot = join(worktreesBaseRoot, parts[0]);
      return {
        allowed: true,
        ...(repoRoot !== undefined ? { repoRoot } : {}),
        worktreeRoot: worktreesRoot,
        worktreePath: join(worktreesRoot, parts[1]),
      };
    }
  }

  return {
    allowed: false,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    worktreePath: resolvedCwd,
  };
}

async function resolveMetadataOwnedWorktree(
  cwd: string,
  repoRoot: string | undefined,
): Promise<{ worktreePath: string; worktreeRoot: string } | null> {
  try {
    const root = await findPaseoWorktreeRootForCwd(cwd);
    if (!root) return null;
    const candidate = await normalizePathForOwnership(root);
    if (repoRoot !== undefined && candidate === (await normalizePathForOwnership(repoRoot)))
      return null;
    const { entries } = await readGitWorktreeEntries(candidate);
    for (const entry of entries) {
      if ((await normalizePathForOwnership(entry.path)) === candidate) {
        return { worktreePath: candidate, worktreeRoot: dirname(candidate) };
      }
    }
    return null;
  } catch {
    return null;
  }
}

type ParsedPaseoWorktreeInfo = Omit<PaseoWorktreeInfo, "createdAt">;

interface ParsedWorktreeEntry extends ParsedPaseoWorktreeInfo {
  /** A bare repository or a worktree whose directory is gone; nothing can work there. */
  unusable?: true;
}

/**
 * Single worktree-list reader shared by adoption snapshots, discovery, and marker ownership.
 * Uses Git 2.36+'s NUL-delimited `-z` output (`exact: true`) to preserve paths containing
 * line breaks or trailing whitespace, falling back to line-delimited `--porcelain`
 * (`exact: false`) on Git 2.35 and earlier.
 */
async function readGitWorktreeEntries(
  cwd: string,
): Promise<{ entries: ParsedWorktreeEntry[]; exact: boolean }> {
  const nulResult = await runGitCommand(["worktree", "list", "--porcelain", "-z"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
    acceptExitCodes: [0, 129],
  });
  if (nulResult.exitCode === 0) {
    return {
      entries: parseWorktreeEntriesTokens(nulResult.stdout.split("\0"), false),
      exact: true,
    };
  }
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return {
    entries: parseWorktreeEntriesTokens(stdout.split("\n"), true),
    exact: false,
  };
}

function parseWorktreeEntriesTokens(
  tokens: readonly string[],
  lineDelimited: boolean,
): ParsedWorktreeEntry[] {
  const entries: ParsedWorktreeEntry[] = [];
  let current: ParsedWorktreeEntry | null = null;

  for (const rawToken of tokens) {
    const token = lineDelimited ? rawToken.replace(/\r$/, "") : rawToken;
    if (token.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      // Preserve trailing spaces in worktree paths even on line-delimited output.
      current = { path: token.slice("worktree ".length) };
      continue;
    }

    if (!current) {
      continue;
    }

    if (token.startsWith("branch ")) {
      const ref = token.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (token.startsWith("HEAD ")) {
      current.head = token.slice("HEAD ".length).trim();
    } else if (token === "bare" || token.startsWith("prunable")) {
      current.unusable = true;
    } else if ((lineDelimited ? token.trim() : token).length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

async function resolveWorktreeCreatedAtIso(worktreePath: string): Promise<string> {
  try {
    const stats = await stat(worktreePath);
    const birthtimeMs = stats.birthtimeMs;
    const createdAtMs =
      Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** One git worktree of a repository, whoever created it. */
export interface GitWorktree {
  path: string;
  /** Null when HEAD is detached. */
  branchName: string | null;
  head: string | null;
  createdAt: string;
  /** Whether the `cwd` the list was asked for is inside this worktree. */
  containsCwd: boolean;
}

/**
 * Every usable worktree of the repository `cwd` is in. The main worktree comes first; the rest
 * follow in no meaningful order.
 * Unlike `listPaseoWorktrees`, ownership plays no part.
 */
export async function listGitWorktrees({ cwd }: { cwd: string }): Promise<GitWorktree[]> {
  const { entries } = await readGitWorktreeEntries(cwd);
  const { stdout: toplevel } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const cwdWorktree = await normalizePathForOwnership(toplevel.replace(/\r?\n$/, ""));
  const worktrees: GitWorktree[] = [];
  for (const entry of entries) {
    if (entry.unusable) continue;
    // A locked worktree whose directory was deleted is neither prunable nor workable.
    if (!(await pathExists(entry.path))) continue;
    const path = await normalizePathForOwnership(entry.path);
    worktrees.push({
      path,
      branchName: entry.branchName ?? null,
      head: entry.head ?? null,
      createdAt: await resolveWorktreeCreatedAtIso(path),
      containsCwd: path === cwdWorktree,
    });
  }
  return worktrees;
}

export interface ListPaseoWorktreesOptions {
  cwd: string;
  paseoHome?: string;
  worktreesRoot?: string;
}

export function listPaseoWorktrees(
  options: ListPaseoWorktreesOptions,
): Promise<PaseoWorktreeInfo[]> {
  return runWithRepositoryRoot(options.cwd, () => listPaseoWorktreesAtRepositoryRoot(options));
}

async function listPaseoWorktreesAtRepositoryRoot({
  cwd,
  paseoHome,
  worktreesRoot,
}: ListPaseoWorktreesOptions): Promise<PaseoWorktreeInfo[]> {
  const projectWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesRoot);
  const { entries } = await readGitWorktreeEntries(cwd);

  const mainCheckoutPath = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(cwd));
  const roots = await ownershipPathVariants(projectWorktreesRoot);
  const worktrees: PaseoWorktreeInfo[] = [];
  // Inspect foreign paths sequentially; a large worktree list must not consume the FS pool.
  for (const { unusable: _unusable, ...entry } of entries) {
    const path = await normalizePathForOwnership(entry.path);
    if (
      !roots.some((root) => getRelativePathInsideRoot(root, path) !== null) &&
      !(path !== mainCheckoutPath && (await hasPaseoWorktreeMetadata(path)))
    )
      continue;
    worktrees.push({ ...entry, path, createdAt: await resolveWorktreeCreatedAtIso(path) });
  }
  return worktrees;
}

/**
 * Exact normalized paths of all currently registered worktrees for the repo containing `cwd`.
 * Returns `null` on Git <= 2.35 where `--porcelain -z` is unavailable, so manager checkout
 * falls back to built-in Git rather than trusting an inexact snapshot for adoption or rollback.
 */
async function listExactGitWorktreePaths(cwd: string): Promise<Set<string> | null> {
  const { entries, exact } = await readGitWorktreeEntries(cwd);
  if (!exact) return null;
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(normalizePathForIdentity(entry.path));
  }
  return paths;
}

export interface DeletePaseoWorktreeOptions {
  cwd: string | null;
  worktreePath?: string;
  teardownCwds?: string[];
  worktreeSlug?: string;
  worktreesRoot?: string;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  // The caller has a workspace registry record backing worktreePath (the
  // record's cwd is this path). Registry membership is an ownership proof
  // in its own right: it covers worktrees whose git admin dir is already
  // gone, where the marker proof can no longer be verified. Only pass
  // this when the record was matched against the path by the caller.
  registryProven?: boolean;
  worktreeManagers?: Pick<PluginWorktreeManagerRuntime, "removeWorktree">;
  worktreeManagerPluginId?: string | null;
  removeReason?: "archive" | "rollback";
  untrusted?: boolean;
  signal?: AbortSignal;
}

// Project scoping for delete: a proof for some other repo's worktree must
// not make this repo's delete remove it. Only refuses on a positive
// mismatch — when git has forgotten either side, the ownership proof the
// caller already established stands.
async function assertWorktreeBelongsToRepo(cwd: string, worktreePath: string): Promise<void> {
  let callerRepoRoot: string;
  let targetRepoRoot: string;
  try {
    callerRepoRoot = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(cwd));
    targetRepoRoot = await resolveRepoRootFromGitCommonDir(await getGitCommonDir(worktreePath));
  } catch {
    return;
  }
  if ((await getOwnershipRelativePath(callerRepoRoot, targetRepoRoot)) !== "") {
    throw new Error("Refusing to delete non-Paseo worktree");
  }
}

export async function readWorktreeHead(worktreePath: string): Promise<string | null> {
  if (!(await pathExists(join(worktreePath, ".git")))) return null;
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function readWorktreeHeadReference(worktreePath: string): Promise<string | null> {
  if (!(await pathExists(join(worktreePath, ".git")))) return null;
  try {
    const result = await runGitCommand(["symbolic-ref", "--quiet", "HEAD"], {
      cwd: worktreePath,
      acceptExitCodes: [0, 1],
    });
    if (result.exitCode === 0) return result.stdout.trim();
    return readWorktreeHead(worktreePath);
  } catch {
    return null;
  }
}

export function deletePaseoWorktree(options: DeletePaseoWorktreeOptions): Promise<void> {
  const operation = () => deletePaseoWorktreeAtRepositoryRoot(options);
  return options.cwd ? runWithRepositoryRoot(options.cwd, operation) : operation();
}

async function deletePaseoWorktreeAtRepositoryRoot({
  cwd,
  worktreePath,
  teardownCwds,
  worktreeSlug,
  worktreesRoot,
  paseoHome,
  worktreesBaseRoot,
  registryProven,
  worktreeManagers,
  worktreeManagerPluginId,
  removeReason = "archive",
  untrusted = false,
  signal,
}: DeletePaseoWorktreeOptions): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  // Resolve the worktrees-root. With a repo cwd we hash it the normal way; if
  // git has forgotten about the worktree we expect the caller to hand us the
  // path-derived worktreesRoot from the ownership check.
  let resolvedWorktreesRoot: string;
  if (worktreesRoot) {
    resolvedWorktreesRoot = worktreesRoot;
  } else if (cwd) {
    resolvedWorktreesRoot = await getPaseoWorktreesRoot(cwd, paseoHome, worktreesBaseRoot);
  } else {
    throw new Error("cwd or worktreesRoot is required to delete a Paseo worktree");
  }

  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const ownership = await isPaseoOwnedWorktreeCwd(requestedPath, {
    paseoHome,
    worktreesRoot: worktreesBaseRoot,
  });
  // Deletion is gated on the ownership proof set (legacy shape, the
  // paseo/worktree.json marker verified against `git worktree list`, or a
  // caller-asserted registry record), not on living under the per-project
  // hashed root: plugin-placed worktrees live anywhere.
  let resolvedWorktree: string;
  if (registryProven) {
    resolvedWorktree = await normalizePathForOwnership(requestedPath);
  } else if (ownership.allowed && ownership.worktreePath) {
    resolvedWorktree = ownership.worktreePath;
  } else {
    throw new Error("Refusing to delete non-Paseo worktree");
  }

  if (cwd) {
    await assertWorktreeBelongsToRepo(cwd, resolvedWorktree);
  }

  if (await pathExists(resolvedWorktree)) {
    const removedByPlugin = await prepareAndTryPluginWorktreeRemove({
      cwd,
      resolvedWorktree,
      teardownCwds,
      worktreeManagers,
      worktreeManagerPluginId,
      removeReason,
      untrusted,
      signal,
    });
    if (removedByPlugin) {
      await pruneWorktreesBestEffort(cwd);
      return;
    }
  }

  if (cwd) {
    try {
      await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
        cwd,
        timeout: 120_000,
      });
    } catch {
      // `git worktree remove` fails if the admin dir is already gone (e.g. a
      // prior archive attempt removed it before the working tree could be
      // fully cleaned up), or if the repo root has moved. Fall through to the
      // rm retry loop below so the operation stays idempotent.
    }
  }

  await removeDirectoryWithRetries(resolvedWorktree);
  await pruneWorktreesBestEffort(cwd);
}

async function assertNoNestedLinkedWorktrees(worktreePath: string): Promise<void> {
  const pending = [worktreePath];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      directory !== worktreePath &&
      entries.some((entry) => entry.name === ".git" && !entry.isDirectory()) &&
      (await isLinkedGitWorktree(directory))
    ) {
      throw new Error(
        `Refusing to delete worktree ${worktreePath}: contains nested Git worktree ${directory}`,
      );
    }
    for (const entry of entries) {
      if (entry.name !== ".git" && entry.isDirectory()) {
        pending.push(join(directory, entry.name));
      }
    }
  }
}

async function isLinkedGitWorktree(directory: string): Promise<boolean> {
  // A linked worktree's Git directory contains a commondir file pointing to the
  // shared repository. A submodule or a clone with a separate Git directory
  // uses its own Git directory as the common directory.
  const result = await runGitCommand(
    ["rev-parse", "--path-format=absolute", "--git-path", "commondir"],
    { cwd: directory, envOverlay: READ_ONLY_GIT_ENV },
  ).catch(() => null);
  return result !== null && (await pathExists(result.stdout.replace(/\r?\n$/, "")));
}

async function pruneWorktreesBestEffort(cwd: string | null): Promise<void> {
  if (!cwd) return;
  try {
    await runGitCommand(["worktree", "prune"], { cwd, timeout: 30_000 });
  } catch {
    // not critical; git will prune lazily
  }
}

async function prepareAndTryPluginWorktreeRemove(options: {
  cwd: string | null;
  resolvedWorktree: string;
  teardownCwds?: string[];
  worktreeManagers?: Pick<PluginWorktreeManagerRuntime, "removeWorktree">;
  worktreeManagerPluginId?: string | null;
  removeReason: "archive" | "rollback";
  untrusted: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  const {
    cwd,
    resolvedWorktree,
    teardownCwds,
    worktreeManagers,
    worktreeManagerPluginId,
    removeReason,
    untrusted,
    signal,
  } = options;
  for (const teardownCwd of teardownCwds ?? [resolvedWorktree]) {
    await runWorktreeTeardownCommands({
      worktreePath: resolvedWorktree,
      teardownCwd,
    });
  }
  const effectiveManagerPluginId =
    worktreeManagerPluginId !== undefined
      ? worktreeManagerPluginId
      : ((await readPaseoWorktreeMetadata(resolvedWorktree).catch(() => null))
          ?.worktreeManagerPluginId ?? null);
  if (effectiveManagerPluginId) {
    await assertNoNestedLinkedWorktrees(resolvedWorktree);
  }
  const branch = effectiveManagerPluginId
    ? await getCurrentBranch(resolvedWorktree).catch(() => null)
    : null;
  const commit = await readWorktreeHead(resolvedWorktree);
  if (commit) {
    await runGitCommand(["update-ref", `refs/paseo/kept-commits/${commit}`, commit], {
      cwd: resolvedWorktree,
    });
  }
  if (!effectiveManagerPluginId || !worktreeManagers) {
    return false;
  }
  const removedByPlugin = await worktreeManagers.removeWorktree(
    {
      repoRoot: cwd,
      path: resolvedWorktree,
      branch,
      reason: removeReason,
      force: true,
      untrusted,
    },
    { preferredPluginId: effectiveManagerPluginId, signal },
  );
  if (removedByPlugin === null) {
    return false;
  }
  if (await pathExists(resolvedWorktree)) {
    throw new Error(
      `Plugin ${removedByPlugin.pluginId} worktree.remove reported removed, but the directory still exists: ${resolvedWorktree}`,
    );
  }
  return true;
}

export async function rollbackCreatedPaseoWorktree(
  options: DeletePaseoWorktreeOptions,
  cause: unknown,
): Promise<never> {
  let cleanupError: unknown;
  try {
    await deletePaseoWorktree(options);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const failure = new Error(
      `${cause instanceof Error ? cause.message : "Worktree workflow failed"}; rollback also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause },
    );
    Object.assign(failure, { cleanupError });
    throw failure;
  }
  throw cause;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeDirectoryWithRetries(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const delaysMs = [0, 100, 300, 700, 1500];
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
    try {
      await rm(path, { recursive: true, force: true });
      if (!(await pathExists(path))) {
        return;
      }
      lastError = new Error(`Directory still present after rm: ${path}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (await pathExists(path)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to remove worktree directory: ${path}`);
  }
}

async function listLocalBranchNames(cwd: string): Promise<Set<string>> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd },
  );
  return new Set(
    stdout
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

// The one local branch a source plan can create while resolving: a
// checkout-branch plan fetches refs/heads/<source.branchName>, and a
// change-request/PR plan fetches refs/heads/<localBranchName> (which is
// the plan's branchName). branch-off creates no local branch. Only this
// ref may be rolled back when creation fails — never any other
// branch that appeared in the meantime; other creators own those.
function planCreatedLocalBranch(
  source: WorktreeSource,
  sourcePlan: WorktreeSourcePlan,
): string | null {
  switch (source.kind) {
    case "checkout-branch":
      return source.branchName;
    case "checkout-change-request":
    case "checkout-github-pr":
      return sourcePlan.branchName;
    default:
      return null;
  }
}

async function readLocalBranchTip(cwd: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(
      ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`],
      { cwd },
    );
    const tip = stdout.trim();
    return tip.length > 0 ? tip : null;
  } catch {
    return null;
  }
}

/** Resolve the default placement once, before presenting it to creation hooks. */
export async function resolveDefaultWorktreePath(
  options: Pick<CreateWorktreeOptions, "cwd" | "paseoHome" | "worktreesRoot" | "worktreeSlug">,
): Promise<string> {
  const original = join(
    await getPaseoWorktreesRoot(options.cwd, options.paseoHome, options.worktreesRoot),
    options.worktreeSlug,
  );
  let candidate = original;
  let suffix = 1;
  while (await pathExists(candidate)) candidate = `${original}-${suffix++}`;
  return candidate;
}

/**
 * Create a git worktree with proper naming conventions
 */
export function createWorktree(
  options: CreateWorktreeOptions & { source: Exclude<WorktreeSource, { kind: "restore-commit" }> },
): Promise<CreatedWorktree>;
export function createWorktree(
  options: CreateWorktreeOptions,
): Promise<Omit<CreatedWorktree, "branchName"> & { branchName: string | null }>;
export function createWorktree(
  options: CreateWorktreeOptions,
): Promise<Omit<CreatedWorktree, "branchName"> & { branchName: string | null }> {
  return runWithRepositoryRoot(options.cwd, () => createWorktreeAtRepositoryRoot(options));
}

async function createWorktreeAtRepositoryRoot({
  cwd,
  source,
  preparedBranchOff,
  worktreeSlug,
  paseoHome,
  worktreesRoot,
  worktreePath: explicitWorktreePath,
}: CreateWorktreeOptions): Promise<
  Omit<CreatedWorktree, "branchName"> & { branchName: string | null }
> {
  const branchesBefore =
    source.kind === "checkout-branch" ||
    source.kind === "checkout-change-request" ||
    source.kind === "checkout-github-pr"
      ? await listLocalBranchNames(cwd)
      : new Set<string>();
  const sourcePlan = await resolveWorktreeSourcePlan({
    cwd,
    source,
    desiredSlug: worktreeSlug,
    preparedBranchOff,
  });
  const fetchedBranch = planCreatedLocalBranch(source, sourcePlan);
  const fetchedTip =
    fetchedBranch && !branchesBefore.has(fetchedBranch)
      ? await readLocalBranchTip(cwd, fetchedBranch)
      : null;
  try {
    let worktreePath =
      explicitWorktreePath ??
      (await resolveDefaultWorktreePath({ cwd, paseoHome, worktreesRoot, worktreeSlug }));
    await mkdir(dirname(worktreePath), { recursive: true });

    // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
    await runGitCommand(["worktree", "add", worktreePath, ...sourcePlan.addArguments], {
      cwd,
      timeout: 120_000,
    });
    worktreePath = await normalizePathForOwnership(worktreePath);

    if (sourcePlan.branchName) {
      await applyWorktreeRemotePlan(cwd, sourcePlan.branchName, sourcePlan);
    }

    await writePaseoWorktreeMetadata(worktreePath, {
      baseRefName: sourcePlan.metadataBaseRefName,
      ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
      ...(sourcePlan.changeRequestLookupTarget
        ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
        : {}),
    });

    await seedPaseoConfigFile({ sourceCwd: cwd, targetCwd: worktreePath });

    return {
      branchName: sourcePlan.branchName,
      worktreePath,
      comparisonBaseRef: sourcePlan.metadataBaseRef ?? sourcePlan.metadataBaseRefName,
    };
  } catch (error) {
    if (
      fetchedBranch &&
      fetchedTip &&
      (await readLocalBranchTip(cwd, fetchedBranch)) === fetchedTip
    ) {
      await runGitCommand(["branch", "-D", fetchedBranch], { cwd }).catch(() => {});
    }
    throw error;
  }
}

interface AdoptPluginWorktreeOptions {
  cwd: string;
  source: WorktreeSource;
  worktreePath: string;
  worktreeManagerPluginId: string;
  /** Worktree paths that existed before creation; an overlap fails instead of hijacking user worktrees. */
  existingWorktreePaths?: ReadonlySet<string>;
  /** Remote head commit resolved before invoking the manager for change-request checkouts (`null` if unresolvable). */
  expectedChangeRequestHeadSha?: string | null;
}

export interface RunPluginWorktreeManagerCheckoutOptions<
  Source extends WorktreeSource = WorktreeSource,
> {
  cwd: string;
  source: Source;
  operation: "create" | "restore";
  preferredPluginId?: string;
  untrusted: boolean;
  paseoHome?: string;
  worktreesBaseRoot?: string;
  worktreeManagers?: Pick<PluginWorktreeManagerRuntime, "hasWorktreeManager" | "removeWorktree">;
  run: (context: {
    changeRequestHeadSha?: string;
  }) => Promise<{ pluginId: string; path: string } | null>;
  verifyValidatedPath?: (validatedPath: string, pluginId: string) => void;
}

/**
 * Run a worktree manager plugin's `create` or `restore` callback with a single
 * shared sequence: capability guard, pre-call snapshot, Git validation and
 * adoption, and rollback of a checkout reported by the manager.
 * Returns `null` without spawning Git when no eligible manager is registered
 * or when the manager declines.
 */
export function runPluginWorktreeManagerCheckout(
  options: RunPluginWorktreeManagerCheckoutOptions<
    Exclude<WorktreeSource, { kind: "restore-commit" }>
  >,
): Promise<CreatedWorktree | null>;
export function runPluginWorktreeManagerCheckout(
  options: RunPluginWorktreeManagerCheckoutOptions,
): Promise<(Omit<CreatedWorktree, "branchName"> & { branchName: string | null }) | null>;
export function runPluginWorktreeManagerCheckout(
  options: RunPluginWorktreeManagerCheckoutOptions,
): Promise<(Omit<CreatedWorktree, "branchName"> & { branchName: string | null }) | null> {
  return runWithRepositoryRoot(options.cwd, () =>
    runPluginWorktreeManagerCheckoutAtRepositoryRoot(options),
  );
}

async function runPluginWorktreeManagerCheckoutAtRepositoryRoot(
  options: RunPluginWorktreeManagerCheckoutOptions,
): Promise<(Omit<CreatedWorktree, "branchName"> & { branchName: string | null }) | null> {
  const {
    cwd,
    source,
    operation,
    preferredPluginId,
    untrusted,
    paseoHome,
    worktreesBaseRoot,
    worktreeManagers,
    run,
    verifyValidatedPath,
  } = options;
  if (!worktreeManagers?.hasWorktreeManager({ operation, preferredPluginId })) {
    return null;
  }
  const existingWorktreePaths = await listExactGitWorktreePaths(cwd);
  if (!existingWorktreePaths) {
    return null;
  }
  const expectedChangeRequestHeadSha =
    operation === "create" &&
    (source.kind === "checkout-change-request" || source.kind === "checkout-github-pr")
      ? await fetchChangeRequestHeadSha(cwd, source)
      : undefined;
  const managed = await run(
    expectedChangeRequestHeadSha ? { changeRequestHeadSha: expectedChangeRequestHeadSha } : {},
  );
  if (!managed) return null;
  try {
    const validatedPath = await validateWorktreePath({
      candidate: managed.path,
      repoPath: cwd,
      allowExistingPath: true,
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Plugin ${managed.pluginId} worktree.${operation} failed: ${detail}`, {
        cause: error,
      });
    });
    verifyValidatedPath?.(validatedPath, managed.pluginId);
    return await adoptPluginWorktree({
      cwd,
      source,
      worktreePath: validatedPath,
      worktreeManagerPluginId: managed.pluginId,
      existingWorktreePaths,
      expectedChangeRequestHeadSha,
    });
  } catch (error) {
    return cleanupFailedPluginWorktree(
      {
        cwd,
        candidatePath: managed.path,
        existingWorktreePaths,
        worktreeManagers,
        worktreeManagerPluginId: managed.pluginId,
        untrusted,
        paseoHome,
        worktreesBaseRoot,
      },
      error,
    );
  }
}

/**
 * Roll back a newly created worktree that failed adoption or path verification.
 * Only touches a directory that was absent from `existingWorktreePaths` and
 * shares the source repository's Git common dir; preserves rollback failures
 * alongside the adoption error via `rollbackCreatedPaseoWorktree`.
 */
async function cleanupFailedPluginWorktree(
  options: {
    cwd: string;
    candidatePath: string;
    existingWorktreePaths?: ReadonlySet<string>;
    worktreeManagers?: Pick<PluginWorktreeManagerRuntime, "removeWorktree">;
    worktreeManagerPluginId: string;
    untrusted?: boolean;
    paseoHome?: string;
    worktreesBaseRoot?: string;
  },
  cause: unknown,
): Promise<never> {
  const {
    cwd,
    candidatePath,
    existingWorktreePaths,
    worktreeManagers,
    worktreeManagerPluginId,
    untrusted,
    paseoHome,
    worktreesBaseRoot,
  } = options;
  let rootPath: string;
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
      cwd: candidatePath,
    });
    rootPath = await normalizePathForOwnership(stdout.replace(/\r?\n$/, ""));
  } catch {
    throw cause;
  }
  const rootIdentity = normalizePathForIdentity(rootPath);
  if (
    !createRealpathAwarePathMatcher(rootPath)(candidatePath) ||
    Array.from(existingWorktreePaths ?? []).some(
      (existing) => existing === rootIdentity || isPathInsideRoot(rootIdentity, existing),
    )
  ) {
    throw cause;
  }
  const [worktreeCommonDir, repoCommonDir] = await Promise.all([
    getGitCommonDir(rootPath).catch(() => null),
    getGitCommonDir(cwd).catch(() => null),
  ]);
  if (
    !worktreeCommonDir ||
    !repoCommonDir ||
    !createRealpathAwarePathMatcher(worktreeCommonDir)(repoCommonDir)
  ) {
    throw cause;
  }
  return rollbackCreatedPaseoWorktree(
    {
      cwd,
      worktreePath: rootPath,
      teardownCwds: [],
      paseoHome,
      worktreesBaseRoot,
      registryProven: true,
      worktreeManagers,
      worktreeManagerPluginId,
      removeReason: "rollback",
      untrusted,
    },
    cause,
  );
}

async function assertNonOverlappingWorktreePath(input: {
  worktreeManagerPluginId: string;
  normalizedPath: string;
  normalizedIdentity: string;
  repoCommonDir: string;
  existingWorktreePaths: ReadonlySet<string> | undefined;
}): Promise<void> {
  const {
    worktreeManagerPluginId,
    normalizedPath,
    normalizedIdentity,
    repoCommonDir,
    existingWorktreePaths,
  } = input;
  if (!existingWorktreePaths) return;
  const mainRepoRoot = await resolveRepoRootFromGitCommonDir(repoCommonDir).catch(() => undefined);
  const mainRepoIdentity = mainRepoRoot ? normalizePathForIdentity(mainRepoRoot) : null;
  for (const existing of existingWorktreePaths) {
    if (isPathInsideRoot(normalizedIdentity, existing)) {
      throw new Error(
        `Plugin ${worktreeManagerPluginId} created a worktree enclosing an existing worktree (${existing}): ${normalizedPath}`,
      );
    }
    if (existing !== mainRepoIdentity && isPathInsideRoot(existing, normalizedIdentity)) {
      throw new Error(
        `Plugin ${worktreeManagerPluginId} created a worktree nested inside an existing worktree (${existing}): ${normalizedPath}`,
      );
    }
  }
}

/**
 * Verify and adopt a worktree created or restored by a worktree manager plugin.
 * Paseo validates Git worktree postconditions and writes `paseo/worktree.json`
 * so diffs, PR/MR lookup hints, listing, ownership, and removal continue to work.
 */
async function adoptPluginWorktree(
  options: AdoptPluginWorktreeOptions,
): Promise<Omit<CreatedWorktree, "branchName"> & { branchName: string | null }> {
  const {
    cwd,
    source,
    worktreePath,
    worktreeManagerPluginId,
    existingWorktreePaths,
    expectedChangeRequestHeadSha,
  } = options;
  const normalizedPath = await normalizePathForOwnership(worktreePath);
  const normalizedIdentity = normalizePathForIdentity(normalizedPath);
  if (existingWorktreePaths?.has(normalizedIdentity)) {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} returned an already-existing worktree: ${normalizedPath}`,
    );
  }
  const { stdout: rootStdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: normalizedPath,
  }).catch(() => {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} did not create a Git worktree at: ${normalizedPath}`,
    );
  });
  if (!createRealpathAwarePathMatcher(rootStdout.replace(/\r?\n$/, ""))(normalizedPath)) {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} created a worktree whose root is not the returned path: ${normalizedPath}`,
    );
  }
  const [worktreeCommonDir, repoCommonDir] = await Promise.all([
    getGitCommonDir(normalizedPath),
    getGitCommonDir(cwd),
  ]);
  if (!createRealpathAwarePathMatcher(worktreeCommonDir)(repoCommonDir)) {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} created a worktree outside the repository: ${normalizedPath}`,
    );
  }
  await assertNonOverlappingWorktreePath({
    worktreeManagerPluginId,
    normalizedPath,
    normalizedIdentity,
    repoCommonDir,
    existingWorktreePaths,
  });
  const { stdout: branchStdout } = await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: normalizedPath,
  });
  const rawBranch = branchStdout.trim();
  const detached = !rawBranch || rawBranch === "HEAD";
  if (detached && source.kind !== "restore-commit") {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} created a worktree with a detached HEAD: ${normalizedPath}`,
    );
  }
  const branchName = detached ? null : rawBranch;

  await verifyPluginCheckoutTarget({
    cwd,
    source,
    worktreePath: normalizedPath,
    branchName,
    worktreeManagerPluginId,
    expectedChangeRequestHeadSha,
  });

  if (
    (source.kind === "checkout-change-request" || source.kind === "checkout-github-pr") &&
    branchName
  ) {
    const remotePlan = await resolveChangeRequestRemotePlan(cwd, source, branchName);
    await applyWorktreeRemotePlan(cwd, branchName, remotePlan);
  }

  const metadata = await resolveWorktreeMetadata({ cwd, source, branchName });
  await writePaseoWorktreeMetadata(normalizedPath, {
    baseRefName: metadata.metadataBaseRefName,
    ...(metadata.metadataBaseRef ? { baseRef: metadata.metadataBaseRef } : {}),
    ...(metadata.changeRequestLookupTarget
      ? { changeRequestLookupTarget: metadata.changeRequestLookupTarget }
      : {}),
    worktreeManagerPluginId,
  });
  await seedPaseoConfigFile({ sourceCwd: cwd, targetCwd: normalizedPath });

  return {
    branchName,
    worktreePath: normalizedPath,
    comparisonBaseRef: metadata.metadataBaseRef ?? metadata.metadataBaseRefName,
    worktreeManagerPluginId,
  };
}

/**
 * Fetch the remote change-request head once into `refs/paseo/change-requests/<n>` so both the
 * worktree manager (via `request.headSha`) and adoption verification agree on one commit.
 */
async function fetchChangeRequestHeadSha(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "checkout-change-request" | "checkout-github-pr" }>,
): Promise<string> {
  const changeRequestNumber =
    source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
  const destination = `refs/paseo/change-requests/${changeRequestNumber}`;
  await fetchFirstAvailableRef({
    cwd,
    destination,
    sources: source.checkoutRefs ?? [
      { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
    ],
  });
  const { stdout } = await runGitCommand(["rev-parse", "--verify", `${destination}^{commit}`], {
    cwd,
  });
  return stdout.trim();
}

async function verifyPluginChangeRequestHead(options: {
  cwd: string;
  source: Extract<WorktreeSource, { kind: "checkout-change-request" | "checkout-github-pr" }>;
  worktreePath: string;
  worktreeManagerPluginId: string;
  expectedChangeRequestHeadSha?: string | null;
}): Promise<void> {
  const { cwd, source, worktreePath, worktreeManagerPluginId, expectedChangeRequestHeadSha } =
    options;
  const expectedHead =
    expectedChangeRequestHeadSha ?? (await fetchChangeRequestHeadSha(cwd, source));
  const { stdout: headStdout } = await runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: worktreePath,
  });
  const actualHead = headStdout.trim();
  if (actualHead !== expectedHead) {
    throw new Error(
      `Plugin ${worktreeManagerPluginId} checked out ${actualHead}, expected change request head ${expectedHead}`,
    );
  }
}

async function verifyPluginCheckoutTarget(options: {
  cwd: string;
  source: WorktreeSource;
  worktreePath: string;
  branchName: string | null;
  worktreeManagerPluginId: string;
  expectedChangeRequestHeadSha?: string | null;
}): Promise<void> {
  const {
    cwd,
    source,
    worktreePath,
    branchName,
    worktreeManagerPluginId,
    expectedChangeRequestHeadSha,
  } = options;
  if (source.kind === "checkout-change-request" || source.kind === "checkout-github-pr") {
    return verifyPluginChangeRequestHead({
      cwd,
      source,
      worktreePath,
      worktreeManagerPluginId,
      expectedChangeRequestHeadSha,
    });
  }
  if (source.kind === "restore" || source.kind === "restore-from-base") {
    if (branchName !== source.branchName) {
      throw new Error(
        `Plugin ${worktreeManagerPluginId} restored ${branchName ?? "detached HEAD"}, expected branch ${source.branchName}`,
      );
    }
  }
  if (source.kind === "restore-commit" || source.kind === "restore-from-base") {
    const target =
      source.kind === "restore-commit"
        ? source.commit
        : await resolveBaseBranchForWorktree(cwd, source.baseRef);
    const [head, expected] = await Promise.all([
      runGitCommand(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: worktreePath }),
      runGitCommand(["rev-parse", "--verify", `${target}^{commit}`], { cwd }),
    ]);
    if (
      head.stdout.trim() !== expected.stdout.trim() ||
      (source.kind === "restore-commit" && branchName !== null)
    ) {
      const description = source.kind === "restore-commit" ? "detached commit" : "base commit";
      throw new Error(
        `Plugin ${worktreeManagerPluginId} did not restore the expected ${description} ${expected.stdout.trim()}`,
      );
    }
  }
}

async function tryResolveExactBaseRef(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return await resolveBaseBranchForWorktree(cwd, ref);
  } catch {
    return undefined;
  }
}

function branchChangeRequestHint(
  branchName: string | null,
): { changeRequestLookupTarget: PaseoWorktreeChangeRequestHint } | Record<string, never> {
  if (!branchName) return {};
  return {
    changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
      headRef: branchName,
      localBranchName: branchName,
    }),
  };
}

interface ResolvedWorktreeMetadata {
  metadataBaseRefName: string;
  metadataBaseRef?: string;
  changeRequestLookupTarget?: PaseoWorktreeChangeRequestHint;
}

function resolveChangeRequestMetadata(
  source: Extract<WorktreeSource, { kind: "checkout-change-request" | "checkout-github-pr" }>,
  branchName: string | null,
): ResolvedWorktreeMetadata {
  const changeRequestNumber =
    source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
  return {
    metadataBaseRefName: normalizeRequiredBaseBranch(source.baseRefName),
    changeRequestLookupTarget: createPaseoWorktreeChangeRequestHint({
      headRef: source.headRef,
      ...(source.headRepositoryOwner ? { headRepositoryOwner: source.headRepositoryOwner } : {}),
      changeRequestNumber,
      ...(branchName ? { localBranchName: branchName } : {}),
    }),
  };
}

/**
 * Single source of truth for worktree comparison-base and change-request metadata,
 * shared between built-in Git checkout plans and plugin worktree adoption.
 */
async function resolveWorktreeMetadata(options: {
  cwd: string;
  source: WorktreeSource;
  branchName: string | null;
  resolvedBaseRef?: string;
}): Promise<ResolvedWorktreeMetadata> {
  const { cwd, source, branchName, resolvedBaseRef } = options;
  if (source.kind === "checkout-change-request" || source.kind === "checkout-github-pr") {
    return resolveChangeRequestMetadata(source, branchName);
  }
  if (source.kind === "checkout-branch") {
    const resolvedBranch = branchName ?? source.branchName;
    const metadataBaseRefName =
      resolvedBaseRef ?? (await resolveCheckoutBranchBaseRef(cwd, resolvedBranch));
    return { metadataBaseRefName, ...branchChangeRequestHint(resolvedBranch) };
  }
  if (source.kind === "branch-off") {
    const metadataBaseRefName = normalizeRequiredBaseBranch(source.baseBranch);
    const metadataBaseRef =
      resolvedBaseRef ?? (await tryResolveExactBaseRef(cwd, source.baseBranch));
    return {
      metadataBaseRefName,
      ...(metadataBaseRef ? { metadataBaseRef } : {}),
      ...branchChangeRequestHint(branchName),
    };
  }
  if (source.kind === "restore") {
    const metadataBaseRefName = normalizeRequiredBaseBranch(
      source.baseRef ?? branchName ?? source.branchName,
    );
    const metadataBaseRef =
      resolvedBaseRef ??
      (source.baseRef && isQualifiedRef(source.baseRef)
        ? await tryResolveExactBaseRef(cwd, source.baseRef)
        : undefined);
    return {
      metadataBaseRefName,
      ...(metadataBaseRef ? { metadataBaseRef } : {}),
      ...branchChangeRequestHint(branchName),
    };
  }
  const metadataBaseRefName = normalizeRequiredBaseBranch(source.baseRef);
  const metadataBaseRef =
    resolvedBaseRef ??
    (source.kind === "restore-from-base" || isQualifiedRef(source.baseRef)
      ? await tryResolveExactBaseRef(cwd, source.baseRef)
      : undefined);
  return { metadataBaseRefName, ...(metadataBaseRef ? { metadataBaseRef } : {}) };
}

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
  preparedBranchOff?: PreparedWorktreeBranchOff;
}

interface WorktreeSourcePlan {
  branchName: string | null;
  // Display name and exact ref are two different facts. The name cannot round-trip to a
  // commit — "main" resolves local-first even when the worktree was cut from a fork's
  // upstream — so comparisons and actions read the ref and the UI reads the name.
  metadataBaseRefName: string;
  metadataBaseRef?: string;
  changeRequestLookupTarget?: PaseoWorktreeChangeRequestHint;
  addArguments: string[];
  pushRemote?: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
  trackingRemote?: {
    name: string;
    headRef: string;
  };
}

async function resolveRestoredWorktreeSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore" }>,
): Promise<WorktreeSourcePlan> {
  await validateGitBranchName(cwd, source.branchName);
  await ensureLocalBranch(cwd, source.branchName);
  if (await isBranchCheckedOut(cwd, source.branchName)) {
    throw new BranchAlreadyCheckedOutError(source.branchName);
  }
  const metadata = await resolveWorktreeMetadata({ cwd, source, branchName: source.branchName });
  return {
    branchName: source.branchName,
    ...metadata,
    addArguments: [source.branchName],
  };
}

async function resolveRestoredCommitSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore-commit" }>,
): Promise<WorktreeSourcePlan> {
  const metadata = await resolveWorktreeMetadata({ cwd, source, branchName: null });
  return {
    branchName: null,
    ...metadata,
    addArguments: ["--detach", source.commit],
  };
}

async function resolveRestoredWorktreeFromBasePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore-from-base" }>,
): Promise<WorktreeSourcePlan> {
  await validateGitBranchName(cwd, source.branchName);
  const baseRef = await resolveBaseBranchForWorktree(cwd, source.baseRef);
  const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
  const metadata = await resolveWorktreeMetadata({
    cwd,
    source,
    branchName,
    resolvedBaseRef: baseRef,
  });
  return {
    branchName,
    ...metadata,
    addArguments: ["-b", branchName, "--no-track", baseRef],
  };
}

export function prepareWorktreeBranchOff(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "branch-off" }>,
  previous?: PreparedWorktreeBranchOff,
): Promise<PreparedWorktreeBranchOff> {
  return runWithRepositoryRoot(cwd, () =>
    prepareWorktreeBranchOffAtRepositoryRoot(cwd, source, previous),
  );
}

async function prepareWorktreeBranchOffAtRepositoryRoot(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "branch-off" }>,
  previous?: PreparedWorktreeBranchOff,
): Promise<PreparedWorktreeBranchOff> {
  const baseRef = previous?.baseRef ?? (await resolveBaseBranchForWorktree(cwd, source.baseBranch));
  const branchExists = await localBranchExists(cwd, source.branchName);
  const checkoutRef = branchExists ? source.branchName : (source.startPoint ?? baseRef);
  if (checkoutRef !== previous?.checkoutRef) {
    await refreshRemoteTrackingBaseRef(cwd, checkoutRef);
  }
  return { baseRef, branchExists, checkoutRef };
}

async function resolveBranchOffWorktreeSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "branch-off" }>,
  desiredSlug: string,
  preparedBranchOff?: PreparedWorktreeBranchOff,
): Promise<WorktreeSourcePlan> {
  const branchName = source.branchName;
  await validateGitBranchName(cwd, branchName);
  const { baseRef, branchExists, checkoutRef } = await prepareWorktreeBranchOff(
    cwd,
    source,
    preparedBranchOff,
  );
  const candidateBranch = branchExists ? desiredSlug : branchName;
  const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);
  const metadata = await resolveWorktreeMetadata({
    cwd,
    source,
    branchName: newBranchName,
    resolvedBaseRef: baseRef,
  });

  return {
    branchName: newBranchName,
    ...metadata,
    addArguments: ["-b", newBranchName, "--no-track", checkoutRef],
  };
}

async function resolveWorktreeSourcePlan({
  cwd,
  source,
  desiredSlug,
  preparedBranchOff,
}: ResolveWorktreeSourcePlanOptions): Promise<WorktreeSourcePlan> {
  switch (source.kind) {
    case "branch-off":
      return resolveBranchOffWorktreeSourcePlan(cwd, source, desiredSlug, preparedBranchOff);
    case "restore":
      return resolveRestoredWorktreeSourcePlan(cwd, source);
    case "restore-commit":
      return resolveRestoredCommitSourcePlan(cwd, source);
    case "restore-from-base":
      return resolveRestoredWorktreeFromBasePlan(cwd, source);
    case "checkout-branch": {
      await validateGitBranchName(cwd, source.branchName);
      await ensureLocalBranch(cwd, source.branchName);
      const baseRef = await resolveCheckoutBranchBaseRef(cwd, source.branchName);
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
        const metadata = await resolveWorktreeMetadata({
          cwd,
          source,
          branchName,
          resolvedBaseRef: baseRef,
        });
        return {
          branchName,
          ...metadata,
          addArguments: ["-b", branchName, "--no-track", source.branchName],
        };
      }

      const metadata = await resolveWorktreeMetadata({
        cwd,
        source,
        branchName: source.branchName,
        resolvedBaseRef: baseRef,
      });
      return {
        branchName: source.branchName,
        ...metadata,
        addArguments: [source.branchName],
      };
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      await validateGitBranchName(cwd, localBranchCandidate);
      const localBranchName = await resolveUniqueLocalBranchName(cwd, localBranchCandidate);
      const changeRequestNumber =
        source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
      await fetchFirstAvailableRef({
        cwd,
        destination: `refs/heads/${localBranchName}`,
        sources: source.checkoutRefs ?? [
          { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
        ],
      });
      const remotePlan = await resolveChangeRequestRemotePlan(cwd, source, localBranchName);

      const metadata = await resolveWorktreeMetadata({
        cwd,
        source,
        branchName: localBranchName,
      });
      return {
        branchName: localBranchName,
        ...metadata,
        addArguments: [localBranchName],
        ...remotePlan,
      };
    }
  }
}

async function resolveChangeRequestRemotePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "checkout-change-request" | "checkout-github-pr" }>,
  localBranchName: string,
): Promise<Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote">> {
  const changeRequestNumber =
    source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
  const shouldTrackOriginHead = source.trackOriginHead === true;
  const trackingRemote = shouldTrackOriginHead
    ? await tryFetchWorktreeTrackingRemote({
        cwd,
        remoteName: "origin",
        headRef: source.headRef,
      })
    : undefined;
  const remotePlan: Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote"> = {};
  if (source.pushRemoteUrl) {
    remotePlan.pushRemote = {
      name: `paseo-pr-${changeRequestNumber}`,
      url: source.pushRemoteUrl,
      headRef: source.headRef,
      track: true,
    };
  } else if (shouldTrackOriginHead && localBranchName !== source.headRef) {
    const originUrl = await getWorktreeRemotePushUrl(cwd, "origin");
    if (originUrl) {
      remotePlan.pushRemote = {
        name: `paseo-pr-${changeRequestNumber}`,
        url: originUrl,
        headRef: source.headRef,
        track: false,
      };
    }
  }
  if (trackingRemote) {
    remotePlan.trackingRemote = trackingRemote;
  }
  return remotePlan;
}

async function applyWorktreeRemotePlan(
  cwd: string,
  branchName: string,
  remotePlan: Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote">,
): Promise<void> {
  if (remotePlan.pushRemote) {
    await configureWorktreePushRemote({
      cwd,
      branchName,
      remote: remotePlan.pushRemote,
    });
  }
  if (remotePlan.trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd,
      branchName,
      remote: remotePlan.trackingRemote,
    });
  }
}

async function configureWorktreePushRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
}): Promise<void> {
  await runGitCommand(["config", `remote.${options.remote.name}.url`, options.remote.url], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `remote.${options.remote.name}.push`, `HEAD:refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
  await runGitCommand(["config", `branch.${options.branchName}.pushRemote`, options.remote.name], {
    cwd: options.cwd,
  });
  if (!options.remote.track) {
    return;
  }
  await runGitCommand(
    [
      "config",
      `remote.${options.remote.name}.fetch`,
      `+refs/heads/${options.remote.headRef}:refs/remotes/${options.remote.name}/${options.remote.headRef}`,
    ],
    { cwd: options.cwd },
  );
  const trackingRemote = await tryFetchWorktreeTrackingRemote({
    cwd: options.cwd,
    remoteName: options.remote.name,
    headRef: options.remote.headRef,
  });
  if (trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd: options.cwd,
      branchName: options.branchName,
      remote: trackingRemote,
    });
  }
}

/**
 * Fetches the first of `sources` a remote serves into the local ref `destination`, and returns
 * the name of that remote.
 */
export interface FetchFirstAvailableRefOptions {
  cwd: string;
  sources: WorktreeCheckoutRef[];
  destination: string;
}

export function fetchFirstAvailableRef(options: FetchFirstAvailableRefOptions): Promise<string> {
  return runWithRepositoryRoot(options.cwd, () => fetchFirstAvailableRefAtRepositoryRoot(options));
}

async function fetchFirstAvailableRefAtRepositoryRoot(
  options: FetchFirstAvailableRefOptions,
): Promise<string> {
  let lastResult:
    | Awaited<ReturnType<typeof runGitCommand>>
    | { stderr: string; stdout: string; exitCode: number | null }
    | null = null;
  for (const checkoutRef of options.sources) {
    const remoteName = checkoutRef.remoteName ?? "origin";
    lastResult = await runGitCommand(
      ["fetch", remoteName, `+${checkoutRef.remoteRef}:${options.destination}`, "--force"],
      {
        cwd: options.cwd,
        timeout: 120_000,
        acceptExitCodes: [0, 1, 128],
      },
    );
    if (lastResult.exitCode === 0) {
      return remoteName;
    }
  }
  const attemptedRefs = options.sources
    .map((checkoutRef) => `${checkoutRef.remoteName ?? "origin"} ${checkoutRef.remoteRef}`)
    .join(", ");
  throw new Error(
    `Unable to fetch change request refs into ${options.destination}: ${attemptedRefs}${lastResult?.stderr ? `\n${lastResult.stderr}` : ""}`,
  );
}

async function tryFetchWorktreeTrackingRemote(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<{ name: string; headRef: string } | undefined> {
  const result = await runGitCommand(
    [
      "fetch",
      options.remoteName,
      `+refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`,
    ],
    {
      cwd: options.cwd,
      timeout: 120_000,
      acceptExitCodes: [0, 1, 128],
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  await ensureRemoteFetchesBranch(options);
  return { name: options.remoteName, headRef: options.headRef };
}

async function ensureRemoteFetchesBranch(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<void> {
  const configKey = `remote.${options.remoteName}.fetch`;
  const exactRefspec = `refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`;
  const wildcardRefspec = `refs/heads/*:refs/remotes/${options.remoteName}/*`;
  const { stdout } = await runGitCommand(["config", "--get-all", configKey], {
    cwd: options.cwd,
    acceptExitCodes: [0, 1],
  });
  const alreadyTracked = stdout
    .split("\n")
    .map((refspec) => refspec.trim().replace(/^\+/, ""))
    .some((refspec) => refspec === exactRefspec || refspec === wildcardRefspec);
  if (alreadyTracked) {
    return;
  }
  await runGitCommand(["config", "--add", configKey, `+${exactRefspec}`], { cwd: options.cwd });
}

async function getWorktreeRemotePushUrl(
  cwd: string,
  remoteName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "--push", remoteName], {
      cwd,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

async function configureWorktreeTrackingRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    headRef: string;
  };
}): Promise<void> {
  await runGitCommand(
    [
      "branch",
      "--set-upstream-to",
      `${options.remote.name}/${options.remote.headRef}`,
      options.branchName,
    ],
    { cwd: options.cwd },
  );
}

async function validateGitBranchName(cwd: string, branchName: string): Promise<void> {
  const result = await runGitCommand(["check-ref-format", "--branch", branchName], {
    cwd,
    timeout: 30_000,
    acceptExitCodes: [0, 1, 128],
  });
  if (result.exitCode !== 0) {
    throw new InvalidGitBranchNameError(branchName);
  }
}

function normalizeRequiredBaseBranch(baseBranch: string): string {
  const normalizedBaseBranch = normalizeBaseRefName(baseBranch);
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required when creating a Paseo worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a Paseo worktree");
  }
  return normalizedBaseBranch;
}

// The checked-out branch itself isn't a base to diff against — resolve the
// repository's default branch so the diff panel has a real comparison target.
// If the default branch can't be determined (no origin/HEAD, no local
// main/master — e.g. a local-only repo based on "develop"), fall back to
// whichever branch is currently checked out in the main repo, since that's
// almost always the branch this one was intended to be compared against.
async function resolveCheckoutBranchBaseRef(cwd: string, branchName: string): Promise<string> {
  const defaultBranch = await resolveRepositoryDefaultBranch(cwd);
  if (defaultBranch) {
    return defaultBranch;
  }
  const currentBranch = await getCurrentBranch(cwd);
  return currentBranch && currentBranch !== branchName ? currentBranch : branchName;
}

async function resolveBaseBranchForWorktree(
  cwd: string,
  requestedBaseBranch: string,
): Promise<string> {
  const requested = requestedBaseBranch.trim();
  const normalized = normalizeRequiredBaseBranch(requested);
  let exactRef: string | null = null;
  if (isQualifiedRef(requested)) {
    exactRef = requested;
  } else if (requested.startsWith("origin/")) {
    exactRef = `refs/remotes/${requested}`;
  }

  if (exactRef) {
    try {
      await runGitCommand(["rev-parse", "--verify", exactRef], { cwd });
      return exactRef;
    } catch {
      throw new Error(`Base branch not found: ${exactRef}`);
    }
  }

  const candidates = [`refs/heads/${requested}`, `refs/remotes/origin/${requested}`, requested];
  for (const candidate of candidates) {
    try {
      await runGitCommand(["rev-parse", "--verify", candidate], { cwd });
      return candidate;
    } catch {
      // Try the next unambiguous local, remote, or legacy ref candidate.
    }
  }
  throw new Error(`Base branch not found: ${normalized}`);
}

// Clients give up on a create request after 60s. A remote that accepts the connection and never
// answers (a VPN-only host while off the VPN) must fall back to the cached ref well before that.
const REMOTE_BASE_REFRESH_TIMEOUT_MS = 15_000;

// A remote-tracking base is only as fresh as the last fetch, and the background fetch only runs
// while a workspace of the repository is observed. Refresh the one base branch so the new branch
// starts at the remote tip; when the fetch fails (offline, auth) the cached ref is still usable.
async function refreshRemoteTrackingBaseRef(cwd: string, baseRef: string): Promise<void> {
  if (!baseRef.startsWith("refs/remotes/")) {
    return;
  }
  try {
    // Remote names may contain slashes, so the owning remote is looked up rather than parsed.
    const { stdout } = await runGitCommand(["remote"], { cwd });
    const remoteName = stdout
      .split("\n")
      .map((name) => name.trim())
      .find((name) => name.length > 0 && baseRef.startsWith(`refs/remotes/${name}/`));
    if (!remoteName) {
      return;
    }
    const remoteBranch = baseRef.slice(`refs/remotes/${remoteName}/`.length);
    // No refspec is added to remote.<name>.fetch: one left behind breaks later fetches once the
    // branch is deleted on the remote.
    await runGitCommand(["fetch", remoteName, `+refs/heads/${remoteBranch}:${baseRef}`], {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
      timeout: REMOTE_BASE_REFRESH_TIMEOUT_MS,
      acceptExitCodes: [0, 1, 128],
    });
  } catch {
    // The fetch timed out; branch from the cached ref.
  }
}

async function ensureLocalBranch(cwd: string, branchName: string): Promise<void> {
  if (await localBranchExists(cwd, branchName)) {
    return;
  }
  try {
    await runGitCommand(["fetch", "origin", `${branchName}:${branchName}`], {
      cwd,
      timeout: 120_000,
    });
    return;
  } catch {
    // Origin does not have it; another remote may.
  }
  const remoteBranch = await uniqueRemoteTrackingBranch(cwd, branchName);
  if (!remoteBranch) {
    throw new UnknownBranchError({ branchName, cwd });
  }
  // Tracks the remote it came from, as `git checkout <branch>` does for a branch on one remote.
  await runGitCommand(["branch", "--track", branchName, remoteBranch], { cwd });
}

/** The one remote-tracking ref named `<remote>/<branchName>`, if exactly one remote has it. */
async function uniqueRemoteTrackingBranch(cwd: string, branchName: string): Promise<string | null> {
  const { stdout: remotes } = await runGitCommand(["remote"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const candidates: string[] = [];
  for (const remote of remotes
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)) {
    const ref = `refs/remotes/${remote}/${branchName}`;
    try {
      await runGitCommand(["show-ref", "--verify", "--quiet", ref], { cwd });
      candidates.push(ref);
    } catch {
      // This remote does not have the branch.
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueLocalBranchName(cwd: string, candidateBranch: string): Promise<string> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"],
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
  );
  const existingBranches = new Set(stdout.trim().split("\n").filter(Boolean));
  const candidateSegments = candidateBranch.split("/");
  const segments = [...candidateSegments];
  let suffix = 1;
  while (true) {
    const branchName = segments.join("/");
    const parentConflict = segments.findIndex((_, index) =>
      existingBranches.has(segments.slice(0, index + 1).join("/")),
    );
    const childConflict = [...existingBranches].some((branch) =>
      branch.startsWith(`${branchName}/`),
    );
    if (parentConflict === -1 && !childConflict) {
      return branchName;
    }
    // Git refs form a namespace: a branch cannot also be another branch's
    // parent directory. Rename the conflicting segment, preserving the rest.
    const conflictIndex = parentConflict === -1 ? segments.length - 1 : parentConflict;
    segments[conflictIndex] = `${candidateSegments[conflictIndex]}-${suffix++}`;
  }
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { entries } = await readGitWorktreeEntries(cwd);
  return entries.some((entry) => entry.branchName === branchName);
}
