import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentEnvLayer } from "@getpaseo/protocol/paseo-config-schema";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
} from "../../utils/string-command-shell.js";
import { createExternalProcessEnv } from "../paseo-env.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const MAX_DETAIL_CHARS = 2000;

// Bookkeeping vars the shell sets on its own. They'd otherwise show up in the delta
// (they differ from the daemon baseline) and get injected into the agent as noise.
const SHELL_NOISE_KEYS = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);

/**
 * Raised when an `agentEnv` command layer fails: non-zero exit, spawn error, timeout, or
 * output we can't parse as an environment. Fails the agent launch — we never start an agent
 * with a half-resolved environment.
 *
 * `message` deliberately excludes the command's output. This error reaches clients and the
 * activity log, and the output of an env tool is the one place secrets are guaranteed to be:
 * a direnv/mise error can echo a token, and a parse failure quotes stdout, which IS the
 * environment. `detail` carries the output for the daemon log only — never put it in `message`.
 */
export class PreLaunchEnvError extends Error {
  constructor(
    readonly command: string,
    readonly cwd: string,
    readonly detail: string,
    readonly exitCode?: number,
  ) {
    const exit = exitCode === undefined ? "" : ` (exit ${exitCode})`;
    super(
      `agentEnv command failed${exit}: ${command}. Its output may contain secrets and is not shown here — see the daemon log.`,
    );
    this.name = "PreLaunchEnvError";
  }
}

// Windows environment variable names are case-insensitive, so a command printing `Path`
// must not be treated as a new variable alongside the daemon's `PATH`.
const CASE_INSENSITIVE_ENV = process.platform === "win32";

function lookupEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined || !CASE_INSENSITIVE_ENV) {
    return direct;
  }
  const lowered = key.toLowerCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toLowerCase() === lowered) {
      return value;
    }
  }
  return undefined;
}

/**
 * The name to store a variable under. On Windows the merge itself must case-fold, not just the
 * lookup: storing `Path` next to an existing `PATH` would hand the agent two spellings of one
 * variable and leave which one wins up to the spawn layer. Reuse the casing already in play.
 */
function canonicalEnvKey(key: string, ...sources: NodeJS.ProcessEnv[]): string {
  if (!CASE_INSENSITIVE_ENV) {
    return key;
  }
  const lowered = key.toLowerCase();
  for (const source of sources) {
    for (const candidate of Object.keys(source)) {
      if (candidate.toLowerCase() === lowered) {
        return candidate;
      }
    }
  }
  return key;
}

function parseRecords(records: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const record of records) {
    if (record.length === 0) {
      continue;
    }
    const separator = record.indexOf("=");
    if (separator <= 0) {
      // Not a KEY=VALUE record. Fail loudly rather than silently importing half an
      // environment: a command that logs to stdout is misconfigured, not partially usable.
      throw new Error(
        `expected KEY=VALUE output, got: ${record.slice(0, 80)}${record.length > 80 ? "..." : ""}`,
      );
    }
    result[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return result;
}

/**
 * Parse the environment an `agentEnv` command printed to stdout. Pure; unit-tested.
 *
 * Three accepted encodings, detected in order:
 *   1. a JSON object            (`mise env --json`, any script)
 *   2. NUL-delimited KEY=VALUE  (`direnv exec . env -0`) — the only KEY=VALUE form that can
 *                                carry multi-line values such as a PEM key
 *   3. newline-delimited KEY=VALUE
 */
export function parseEnvOutput(stdout: string): Record<string, string> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error("command printed no environment to stdout");
  }

  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("environment JSON was not an object");
    }
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  }

  // Split the RAW output, not the trimmed copy: trailing whitespace can be part of the last
  // value, and trimming it would corrupt the secret rather than fail.
  if (stdout.includes("\0")) {
    return parseRecords(stdout.split("\0"));
  }
  return parseRecords(stdout.split(/\r?\n/));
}

function boundedStderr(stderr: string): string {
  return stderr.length > MAX_DETAIL_CHARS ? `...${stderr.slice(-MAX_DETAIL_CHARS)}` : stderr;
}

interface ExecLikeError {
  stderr?: unknown;
  code?: unknown;
  killed?: unknown;
  message?: unknown;
}

function describeExecError(error: unknown): { detail: string; exitCode?: number } {
  if (!error || typeof error !== "object") {
    return { detail: String(error) };
  }
  const e = error as ExecLikeError;
  if (e.killed === true) {
    return { detail: "command timed out" };
  }
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  let detail: string;
  if (stderr.length > 0) {
    detail = boundedStderr(stderr);
  } else if (typeof e.message === "string") {
    detail = e.message;
  } else {
    detail = "command failed";
  }
  return { detail, exitCode: typeof e.code === "number" ? e.code : undefined };
}

async function runCommandLayer(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<Record<string, string>> {
  const { command, cwd, env, timeoutMs } = options;
  // Nothing is appended to the user's command — it just prints the environment. That is what
  // keeps this cross-platform: the same shell that already runs `worktree.setup` (bash on
  // POSIX, PowerShell on Windows) with no argv injection and no positional-parameter tricks.
  const invocation = buildStringCommandShellInvocation({ command });

  let stdout: string;
  try {
    const result = await execFileAsync(invocation.shell, invocation.args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    stdout = result.stdout;
  } catch (error) {
    const { detail, exitCode } = describeExecError(error);
    throw new PreLaunchEnvError(command, cwd, detail, exitCode);
  }

  try {
    return parseEnvOutput(stdout);
  } catch (error) {
    throw new PreLaunchEnvError(
      command,
      cwd,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Resolve the committed `agentEnv` layers into the variables to inject into the agent CLI
 * (and, through it, the MCP servers it spawns).
 *
 * Layers merge left to right. A static layer contributes its variables directly — no shell,
 * no subprocess. A command layer runs with every earlier layer already applied, so static
 * config can configure a later command, and contributes only the variables it actually set or
 * changed (the delta), so it never clobbers an unrelated per-user `runtimeSettings.env` key.
 *
 * Throws {@link PreLaunchEnvError} if any command layer fails.
 */
export async function resolveAgentEnvVars(options: {
  layers: AgentEnvLayer[];
  cwd: string;
  runtimeEnv?: Record<string, string>;
  timeoutMs?: number;
}): Promise<Record<string, string>> {
  const { layers, cwd, runtimeEnv, timeoutMs } = options;
  const injected: Record<string, string> = {};

  for (const layer of layers) {
    if (layer.kind === "static") {
      for (const [key, value] of Object.entries(layer.vars)) {
        injected[canonicalEnvKey(key, process.env, injected)] = value;
      }
      continue;
    }

    // The environment this command actually sees: the daemon env (runtime-control vars
    // stripped), the worktree PASEO_* vars, and every layer resolved so far.
    const baseEnv = createStringCommandShellEnv(
      createExternalProcessEnv(process.env, runtimeEnv ?? {}, injected),
    );
    const printed = await runCommandLayer({
      command: layer.command,
      cwd,
      env: baseEnv,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    for (const [key, value] of Object.entries(printed)) {
      if (SHELL_NOISE_KEYS.has(key)) {
        continue;
      }
      if (lookupEnv(baseEnv, key) !== value) {
        injected[canonicalEnvKey(key, baseEnv, injected)] = value;
      }
    }
  }

  return injected;
}
