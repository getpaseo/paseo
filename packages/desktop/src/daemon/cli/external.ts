import { spawnProcess } from "@getpaseo/server";
import log from "electron-log/main";
import type { NodeEntrypointInvocation } from "../node-entrypoint-launcher.js";
import { createNodeEntrypointInvocation } from "../runtime-paths.js";
import { resolveExternalCliEntrypoint } from "./entrypoints.js";

const EXTERNAL_CLI_OUTPUT_CAPTURE_LIMIT_CHARS = 64 * 1024;

interface ExternalCliOutputCapture {
  text: string;
  truncated: boolean;
}

function createExternalCliOutputCapture(): ExternalCliOutputCapture {
  return { text: "", truncated: false };
}

function appendExternalCliOutput(
  capture: ExternalCliOutputCapture,
  chunk: Buffer,
): ExternalCliOutputCapture {
  const nextText = capture.text + chunk.toString();
  if (nextText.length <= EXTERNAL_CLI_OUTPUT_CAPTURE_LIMIT_CHARS) {
    return { text: nextText, truncated: capture.truncated };
  }

  return {
    text: nextText.slice(-EXTERNAL_CLI_OUTPUT_CAPTURE_LIMIT_CHARS),
    truncated: true,
  };
}

function formatExternalCliOutput(capture: ExternalCliOutputCapture): string {
  if (!capture.truncated) {
    return capture.text;
  }

  return `[output truncated to the last ${EXTERNAL_CLI_OUTPUT_CAPTURE_LIMIT_CHARS} chars]\n${capture.text}`;
}

function createExternalCliInvocation(args: string[]): NodeEntrypointInvocation {
  return createNodeEntrypointInvocation({
    entrypoint: resolveExternalCliEntrypoint(),
    argvMode: "node-script",
    args,
    baseEnv: process.env,
  });
}

function spawnExternalCli(invocation: NodeEntrypointInvocation): Promise<{
  stdout: ExternalCliOutputCapture;
  stderr: ExternalCliOutputCapture;
  exitCode: number | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.command, invocation.args, {
      envMode: "internal",
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = createExternalCliOutputCapture();
    let stderr = createExternalCliOutputCapture();

    child.stdout!.on("data", (data: Buffer) => {
      stdout = appendExternalCliOutput(stdout, data);
    });
    child.stderr!.on("data", (data: Buffer) => {
      stderr = appendExternalCliOutput(stderr, data);
    });

    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function externalCliFailureMessage(
  exitCode: number | null,
  stdout: ExternalCliOutputCapture,
  stderr: ExternalCliOutputCapture,
): string {
  const formattedStderr = formatExternalCliOutput(stderr).trim();
  if (formattedStderr.length > 0) {
    return formattedStderr;
  }

  const formattedStdout = formatExternalCliOutput(stdout).trim();
  return `CLI command failed with exit code ${exitCode}${
    formattedStdout.length > 0 ? `\nstdout: ${formattedStdout.slice(0, 200)}` : ""
  }`;
}

export async function runExternalCliTextCommand(args: string[]): Promise<string> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.text.trim();
    const stdout = result.stdout.text.trim();
    log.warn("[desktop external-cli]", "CLI text command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
    });
    throw new Error(externalCliFailureMessage(result.exitCode, result.stdout, result.stderr));
  }

  return result.stdout.text.trimEnd();
}

export async function runExternalCliJsonCommand(args: string[]): Promise<unknown> {
  const invocation = createExternalCliInvocation(args);
  const result = await spawnExternalCli(invocation);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.text.trim();
    const stdout = result.stdout.text.trim();
    log.warn("[desktop external-cli]", "CLI JSON command failed", {
      args,
      exitCode: result.exitCode,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
      command: invocation.command,
    });
    throw new Error(externalCliFailureMessage(result.exitCode, result.stdout, result.stderr));
  }

  const stdout = result.stdout.text.trim();
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
