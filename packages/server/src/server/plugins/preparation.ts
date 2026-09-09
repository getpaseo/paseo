import { spawn } from "node:child_process";
import type pino from "pino";
import type { PluginManifest } from "./manifest.js";

const OUTPUT_LIMIT = 64 * 1024;

export async function runPluginBuild(
  directory: string,
  commands: PluginManifest["build"],
  logger: pino.Logger,
): Promise<void> {
  for (const command of commands ?? []) {
    logger.info({ directory, command }, "Running plugin build command");
    const result = await run(command, directory);
    if (result.stdout)
      logger.info({ directory, command, output: result.stdout }, "Plugin build stdout");
    if (result.stderr)
      logger.info({ directory, command, output: result.stderr }, "Plugin build stderr");
    if (result.error) {
      throw new Error(
        `Plugin build command failed to start: ${formatCommand(command)}\n${result.error.message}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Plugin build command failed (exit ${result.exitCode}): ${formatCommand(command)}${formatOutput(result)}`,
      );
    }
  }
}

function run(command: string[], directory: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const executable = command[0]!;
    const arguments_ = command.slice(1);
    const child = spawn(executable, arguments_, { cwd: directory, shell: false });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk.toString());
    });
    child.once("error", (spawnError) => {
      error = spawnError;
    });
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr, error }));
  });
}

function appendOutput(current: string, next: string): string {
  return `${current}${next}`.slice(-OUTPUT_LIMIT);
}

function formatCommand(command: string[]): string {
  return command.map((argument) => JSON.stringify(argument)).join(" ");
}

function formatOutput(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return output ? `\n${output}` : "";
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
