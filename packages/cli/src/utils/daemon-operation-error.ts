import type { CommandError } from "../output/index.js";

interface DaemonOperationErrorOptions {
  code: string;
  action: string;
  error: unknown;
}

function isCommandError(error: unknown): error is CommandError {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  if (!("message" in error)) {
    return false;
  }
  return typeof error.code === "string" && typeof error.message === "string";
}

function daemonRpcCode(error: Error): string | undefined {
  if (error.name !== "DaemonRpcError" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function buildDaemonOperationCommandError(
  options: DaemonOperationErrorOptions,
): CommandError {
  if (options.error instanceof Error) {
    const message = options.error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
    return {
      code: daemonRpcCode(options.error) ?? options.code,
      message: `Failed to ${options.action}: ${message}`,
    };
  }
  if (isCommandError(options.error)) {
    return options.error;
  }
  return {
    code: options.code,
    message: `Failed to ${options.action}: ${String(options.error)}`,
  };
}
