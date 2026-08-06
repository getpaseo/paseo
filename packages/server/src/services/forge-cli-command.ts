import { z } from "zod";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { execCommand } from "../utils/spawn.js";

/**
 * Timeout for the per-host CLI auth probe (`gh`/`glab`/`tea` auth status) used
 * to detect a self-hosted forge. This intentionally has no anonymous HTTP
 * fallback: a remote-derived host is trusted only when the CLI already knows it.
 */
export const CLI_AUTH_PROBE_TIMEOUT_MS = 10_000;

interface CommandFailureLike {
  code?: string | number | null;
  killed?: boolean;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  message?: string;
}

interface CliCommandErrorShape extends Error {
  stderr: string;
}

interface NormalizeCliCommandErrorOptions {
  error: unknown;
  args: string[];
  cwd: string;
  commandName: string;
  timeoutMs?: number;
  isAlreadyClassified: (error: unknown) => boolean;
  isCommandError: (error: unknown) => error is CliCommandErrorShape;
  isAuthFailureText: (text: string) => boolean;
  createAuthError: (stderr: string) => Error;
  createMissingError: () => Error;
  createCommandError: (params: {
    args: string[];
    cwd: string;
    exitCode: number | null;
    stderr: string;
  }) => Error;
}

interface ParseCliJsonOutputOptions<T> {
  commandName: string;
  args: string[];
  cwd: string;
  stdout: string;
  schema: z.ZodType<T>;
  createCommandError: NormalizeCliCommandErrorOptions["createCommandError"];
}

interface ProbeHostViaCliAuthStatusOptions {
  cli: string;
  host: string;
  envOverlay?: Record<string, string>;
}

export interface ForgeCliRunnerOptions {
  cwd: string;
  envOverlay?: Record<string, string>;
}

export interface ForgeCliRunnerResult {
  stdout: string;
  stderr: string;
}

export type ForgeCliRunner = (
  args: string[],
  options: ForgeCliRunnerOptions,
) => Promise<ForgeCliRunnerResult>;

export interface ForgeCliRunnerErrorClasses {
  isAlreadyClassified: (error: unknown) => boolean;
  isCommandError: (error: unknown) => error is CliCommandErrorShape;
  createAuthError: (stderr: string) => Error;
  createMissingError: () => Error;
  createCommandError: (params: ForgeCommandFailureParams) => Error;
}

export interface CreateForgeCliRunnerOptions {
  binary: string;
  envOverlay: Record<string, string>;
  timeoutMs: number;
  isAuthFailureText: (text: string) => boolean;
  errorClasses: ForgeCliRunnerErrorClasses;
}

export interface ForgeCliRunnerFactory {
  run: ForgeCliRunner;
  normalizeError: (
    error: unknown,
    context: { args: string[]; cwd: string; timeoutMs?: number },
  ) => Error;
}

/**
 * Shared shape behind the gh/glab/tea CLI adapters: an exec wrapper (10MB
 * maxBuffer, per-call env overlay merged over the binary's defaults, a
 * timeout) plus error normalization through the binary's own error-class
 * trio. The three adapters differ only in the params passed here.
 */
export function createForgeCliRunner(options: CreateForgeCliRunnerOptions): ForgeCliRunnerFactory {
  const run: ForgeCliRunner = (args, runOptions) =>
    execCommand(options.binary, args, {
      cwd: runOptions.cwd,
      envOverlay: { ...options.envOverlay, ...runOptions.envOverlay },
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs,
    });

  function normalizeError(
    error: unknown,
    context: { args: string[]; cwd: string; timeoutMs?: number },
  ): Error {
    return normalizeCliCommandError({
      error,
      args: context.args,
      cwd: context.cwd,
      commandName: options.binary,
      timeoutMs: context.timeoutMs ?? options.timeoutMs,
      isAlreadyClassified: options.errorClasses.isAlreadyClassified,
      isCommandError: options.errorClasses.isCommandError,
      isAuthFailureText: options.isAuthFailureText,
      createAuthError: options.errorClasses.createAuthError,
      createMissingError: options.errorClasses.createMissingError,
      createCommandError: options.errorClasses.createCommandError,
    });
  }

  return { run, normalizeError };
}

export class ForgeCliMissingError extends Error {
  readonly kind = "missing-cli";
}

export class ForgeAuthenticationError extends Error {
  readonly kind = "auth-failure";
  readonly stderr: string;

  constructor(message: string, params: { stderr: string }) {
    super(message);
    this.stderr = params.stderr;
  }
}

export interface ForgeCommandFailureParams {
  args: string[];
  cwd: string;
  exitCode: number | null;
  stderr: string;
}

export class ForgeCommandError extends Error {
  readonly kind = "command-error";
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(label: { brand: string; binary: string }, params: ForgeCommandFailureParams) {
    super(`${label.brand} CLI command failed: ${label.binary} ${params.args.join(" ")}`);
    this.args = [...params.args];
    this.cwd = params.cwd;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
  }
}

/**
 * Memoize a CLI path resolver (`findExecutable`) for the lifetime of a service
 * instance. A found path is cached permanently; a miss (or a rejected probe)
 * evicts the cache so a CLI installed after the daemon started is picked up
 * on the next call instead of requiring a restart. Concurrent callers during
 * resolution share the same in-flight promise.
 */
export function createCachedCliPathResolver(
  resolve: () => Promise<string | null>,
): () => Promise<string | null> {
  let pending: Promise<string | null> | null = null;
  return function resolveCliPath(): Promise<string | null> {
    if (pending) {
      return pending;
    }
    const current: Promise<string | null> = resolve()
      .then((path) => {
        if (path === null && pending === current) {
          pending = null;
        }
        return path;
      })
      .catch((error: unknown) => {
        if (pending === current) {
          pending = null;
        }
        throw error;
      });
    pending = current;
    return current;
  };
}

export function bufferOrStringToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

export function normalizeCliCommandError(options: NormalizeCliCommandErrorOptions): Error {
  if (options.isAlreadyClassified(options.error)) {
    return options.error as Error;
  }
  if (options.isCommandError(options.error)) {
    if (options.isAuthFailureText(options.error.stderr)) {
      return options.createAuthError(options.error.stderr);
    }
    return options.error as Error;
  }
  const failure = toCommandFailureLike(options.error);
  if (failure.code === "ENOENT") {
    return options.createMissingError();
  }
  const stderr = bufferOrStringToString(failure.stderr);
  const message = failure.message ?? "";
  if (options.isAuthFailureText(stderr) || options.isAuthFailureText(message)) {
    return options.createAuthError(stderr);
  }
  if (failure.killed === true && options.timeoutMs !== undefined) {
    return options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr:
        stderr ||
        `${options.commandName} was terminated before completing (timed out after ${options.timeoutMs}ms or exceeded the output limit)`,
    });
  }
  return options.createCommandError({
    args: options.args,
    cwd: options.cwd,
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderr: stderr || message,
  });
}

export function parseCliJsonOutput<T>(options: ParseCliJsonOutputOptions<T>): T {
  let data: unknown;
  try {
    data = JSON.parse(options.stdout);
  } catch {
    throw options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr: `${options.commandName} did not return valid JSON (${options.stdout.length} bytes)`,
    });
  }
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) {
    throw options.createCommandError({
      args: options.args,
      cwd: options.cwd,
      exitCode: null,
      stderr: `${options.commandName} JSON did not match the expected schema: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

export async function defaultResolveRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["config", "--get", "remote.origin.url"], { cwd });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function probeHostViaCliAuthStatus(
  options: ProbeHostViaCliAuthStatusOptions,
): Promise<boolean> {
  const cliPath = await findExecutable(options.cli);
  if (!cliPath) {
    return false;
  }
  try {
    await execCommand(options.cli, ["auth", "status", "--hostname", options.host], {
      envOverlay: options.envOverlay,
      timeout: CLI_AUTH_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function toCommandFailureLike(error: unknown): CommandFailureLike {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  return {
    code:
      typeof record.code === "string" || typeof record.code === "number" || record.code === null
        ? record.code
        : undefined,
    killed: typeof record.killed === "boolean" ? record.killed : undefined,
    stderr:
      typeof record.stderr === "string" || Buffer.isBuffer(record.stderr)
        ? record.stderr
        : undefined,
    stdout:
      typeof record.stdout === "string" || Buffer.isBuffer(record.stdout)
        ? record.stdout
        : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}
