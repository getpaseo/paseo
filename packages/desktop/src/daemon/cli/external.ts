import { spawnProcess } from "@getpaseo/server/process";
import log from "electron-log/main";
import type { NodeEntrypointInvocation } from "../node-entrypoint-launcher.js";
import { createNodeEntrypointInvocation } from "../runtime-paths.js";
import { resolveExternalCliEntrypoint } from "./entrypoints.js";

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
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const child = spawnProcess(invocation.command, invocation.args, {
      envMode: "internal",
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      // `spawn` already kills the child on abort; reject deterministically so a
      // racing close event cannot resolve a cancelled command as a success.
      settle(() => reject(new DOMException("Aborted", "AbortError")));
    };

    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (exitCode) => {
      settle(() => resolve({ stdout, stderr, exitCode }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
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

export async function runExternalCliJsonCommand(
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation, signal);

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
    throw new Error(externalCliFailureMessage(result.exitCode, stdout, stderr));
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
