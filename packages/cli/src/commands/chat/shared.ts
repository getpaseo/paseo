import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { parseDuration } from "../../utils/duration.js";
import type { CommandError, CommandOptions } from "../../output/index.js";

export interface ChatCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectChatClient(host?: string) {
  const daemonHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client, daemonHost };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${daemonHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }
}

export function toChatCommandError(code: string, action: string, err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as CommandError;
  }

  const message = err instanceof Error ? err.message : String(err);
  const rpcCode =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;

  return {
    code: rpcCode ?? code,
    message: `Failed to ${action}: ${message}`,
  };
}

export function parseSinceValue(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const durationMs = parseDuration(input);
    return new Date(Date.now() - durationMs).toISOString();
  } catch {
    const timestamp = new Date(input);
    if (Number.isNaN(timestamp.getTime())) {
      const error: CommandError = {
        code: "INVALID_SINCE",
        message: "Invalid --since value",
        details: "Use a duration like 10m or an ISO timestamp.",
      };
      throw error;
    }
    return timestamp.toISOString();
  }
}

export function parseTimeoutMs(input?: string): number | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const timeoutMs = parseDuration(input);
    if (timeoutMs <= 0) {
      throw new Error("Timeout must be positive");
    }
    return timeoutMs;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "INVALID_TIMEOUT",
      message: "Invalid timeout value",
      details: message,
    };
    throw error;
  }
}
