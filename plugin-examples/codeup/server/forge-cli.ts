import { z } from "zod";
import {
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  type ForgeCommandFailureParams,
} from "@getpaseo/plugin/server";
import { execCommand, runGitCommand } from "./process";

export {
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  type ForgeCommandFailureParams,
};

interface CommandFailureLike {
  code?: string | number | null;
  killed?: boolean;
  stderr?: string | Buffer;
  message?: string;
}

interface CliCommandErrorShape extends Error {
  stderr: string;
}

interface ForgeCliRunnerOptions {
  cwd: string;
  binaryPath?: string;
  envOverlay?: Record<string, string>;
}

interface ForgeCliRunnerResult {
  stdout: string;
  stderr: string;
}

interface CreateForgeCliRunnerOptions {
  binary: string;
  envOverlay: Record<string, string>;
  timeoutMs: number;
  isAuthFailureText: (text: string) => boolean;
  errorClasses: {
    isAlreadyClassified: (error: unknown) => boolean;
    isCommandError: (error: unknown) => error is CliCommandErrorShape;
    createAuthError: (stderr: string) => Error;
    createMissingError: () => Error;
    createCommandError: (params: ForgeCommandFailureParams) => Error;
  };
}

export function createForgeCliRunner(options: CreateForgeCliRunnerOptions) {
  return {
    run(args: string[], runOptions: ForgeCliRunnerOptions): Promise<ForgeCliRunnerResult> {
      return execCommand(runOptions.binaryPath ?? options.binary, args, {
        cwd: runOptions.cwd,
        envOverlay: { ...options.envOverlay, ...runOptions.envOverlay },
        maxBuffer: 10 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
    },
    normalizeError(
      error: unknown,
      context: { args: string[]; cwd: string; timeoutMs?: number },
    ): Error {
      if (options.errorClasses.isAlreadyClassified(error)) return error as Error;
      if (options.errorClasses.isCommandError(error)) {
        if (options.isAuthFailureText(error.stderr)) {
          return options.errorClasses.createAuthError(error.stderr);
        }
        return error;
      }
      const failure = toCommandFailureLike(error);
      if (failure.code === "ENOENT") return options.errorClasses.createMissingError();
      const stderr = bufferOrStringToString(failure.stderr);
      const message = failure.message ?? "";
      if (options.isAuthFailureText(stderr) || options.isAuthFailureText(message)) {
        return options.errorClasses.createAuthError(stderr);
      }
      const timeoutMs = context.timeoutMs ?? options.timeoutMs;
      if (failure.killed === true) {
        return options.errorClasses.createCommandError({
          args: context.args,
          cwd: context.cwd,
          exitCode: null,
          stderr:
            stderr ||
            `${options.binary} was terminated before completing (timed out after ${timeoutMs}ms or exceeded the output limit)`,
        });
      }
      return options.errorClasses.createCommandError({
        args: context.args,
        cwd: context.cwd,
        exitCode: typeof failure.code === "number" ? failure.code : null,
        stderr: stderr || `${options.binary} command failed without stderr`,
      });
    },
  };
}

export function createCachedCliPathResolver(
  resolve: () => Promise<string | null>,
): () => Promise<string | null> {
  let pending: Promise<string | null> | null = null;
  return function resolveCliPath(): Promise<string | null> {
    if (pending) return pending;
    const current = resolve()
      .then((path) => {
        if (path === null && pending === current) pending = null;
        return path;
      })
      .catch((error: unknown) => {
        if (pending === current) pending = null;
        throw error;
      });
    pending = current;
    return current;
  };
}

export function parseCliJsonOutput<T>(options: {
  commandName: string;
  args: string[];
  cwd: string;
  stdout: string;
  schema: z.ZodType<T>;
  createCommandError: (params: ForgeCommandFailureParams) => Error;
}): T {
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

function bufferOrStringToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function toCommandFailureLike(error: unknown): CommandFailureLike {
  if (!error || typeof error !== "object") return { message: String(error) };
  const record = error as Record<string, unknown>;
  return {
    code:
      typeof record.code === "string" || typeof record.code === "number" || record.code === null
        ? record.code
        : undefined,
    killed: typeof record.killed === "boolean" ? record.killed : undefined,
    stderr:
      typeof record.stderr === "string" || Buffer.isBuffer(record.stderr)
        ? (record.stderr as string | Buffer)
        : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}
