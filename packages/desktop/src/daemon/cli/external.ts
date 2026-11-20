import { spawnProcess } from "@getpaseo/server/process";
import log from "electron-log/main";
import type { NodeEntrypointInvocation } from "../node-entrypoint-launcher.js";
import { createNodeEntrypointInvocation } from "../runtime-paths.js";
import { resolveExternalCliEntrypoint } from "./entrypoints.js";

/** A CLI command that exited non-zero, with the `--json` error it printed when there was one. */
export class ExternalCliCommandError extends Error {
  readonly code: string | null;
  readonly error: Record<string, unknown> | null;

  constructor(message: string, error: Record<string, unknown> | null) {
    super(message);
    this.name = "ExternalCliCommandError";
    this.error = error;
    this.code = typeof error?.code === "string" ? error.code : null;
  }
}

// `--json` commands print `{ "error": { code, message, ... } }` on stderr when they fail.
function parseJsonCliError(stderr: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stderr) as { error?: unknown };
    return typeof parsed.error === "object" && parsed.error !== null
      ? (parsed.error as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function createExternalCliInvocation(args: string[]): NodeEntrypointInvocation {
  return createNodeEntrypointInvocation({
    entrypoint: resolveExternalCliEntrypoint(),
    argvMode: "node-script",
    args,
    baseEnv: process.env,
  });
}

function spawnExternalCli(
  invocation: NodeEntrypointInvocation,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      envMode: "internal",
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function externalCliFailureMessage(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  if (stderr.length > 0) {
    return stderr;
  }

  return `CLI command failed with exit code ${exitCode}${stdout.length > 0 ? `\nstdout: ${stdout.slice(0, 200)}` : ""}`;
}

export async function runExternalCliTextCommand(args: string[]): Promise<string> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop external-cli]", "CLI text command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    });
    throw new Error(externalCliFailureMessage(result.exitCode, stdout, stderr));
  }

  return result.stdout.trimEnd();
}

export async function runExternalCliJsonCommand(args: string[]): Promise<unknown> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    log.warn("[desktop external-cli]", "CLI JSON command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
      command: invocation.command,
    });
    throw new ExternalCliCommandError(
      externalCliFailureMessage(result.exitCode, stdout, stderr),
      parseJsonCliError(stderr),
    );
  }

  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    log.warn("[desktop external-cli]", "CLI command produced no output", { args });
    throw new Error("CLI command did not produce JSON output.");
  }

  const jsonStart = stdout.search(/[{[]/);
  if (jsonStart < 0) {
    log.warn("[desktop external-cli]", "CLI command output contained no JSON", {
      args,
      stdout: stdout.slice(0, 500),
    });
    throw new Error(`CLI command output contained no JSON. Output: ${stdout.slice(0, 200)}`);
  }

  try {
    return JSON.parse(stdout.slice(jsonStart)) as unknown;
  } catch (error) {
    throw new Error(
      `CLI command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
