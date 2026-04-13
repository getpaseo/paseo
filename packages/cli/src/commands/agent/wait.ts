import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { fetchAgentTimelineItems, formatAgentActivityTranscript } from "./logs.js";
import { parseDuration } from "../../utils/duration.js";

/** Result type for agent wait command */
export interface AgentWaitResult {
  agentId: string;
  status: "idle" | "timeout" | "permission" | "error";
  message: string;
}

/** Schema for agent wait output */
export const agentWaitSchema: OutputSchema<AgentWaitResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "MESSAGE", field: "message", width: 40 },
  ],
};

export interface AgentWaitOptions extends CommandOptions {
  timeout?: string;
  host?: string;
}

const WAIT_ACTIVITY_PREVIEW_COUNT = 5;

function appendRecentActivity(message: string, transcript: string | null): string {
  if (!transcript || transcript.trim().length === 0) {
    return message;
  }

  return `${message}\nLast ${WAIT_ACTIVITY_PREVIEW_COUNT} activity items:\n${transcript}`;
}

async function getRecentActivityTranscript(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  agentId: string,
): Promise<string | null> {
  try {
    const timelineItems = await fetchAgentTimelineItems(client, agentId);
    return formatAgentActivityTranscript(timelineItems, WAIT_ACTIVITY_PREVIEW_COUNT);
  } catch {
    return null;
  }
}

export function addWaitOptions(cmd: Command): Command {
  return cmd
    .description("Wait for an agent to become idle")
    .argument("<id>", "Agent ID (or prefix)")
    .option("--timeout <seconds>", "Maximum wait time (default: no limit)");
}

export async function runWaitCommand(
  agentIdArg: string,
  options: AgentWaitOptions,
  _command: Command,
): Promise<SingleResult<AgentWaitResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: hubcode agent wait <id>",
    };
    throw error;
  }

  // Parse timeout (no limit unless explicitly provided)
  let timeoutMs = 0;
  let timeoutLabel: string | null = null;
  if (options.timeout) {
    try {
      timeoutMs = parseDuration(options.timeout);
      if (timeoutMs <= 0) {
        throw new Error("Timeout must be positive");
      }
      const timeoutSeconds = Math.floor(timeoutMs / 1000);
      timeoutLabel = `${timeoutSeconds} second${timeoutSeconds === 1 ? "" : "s"}`;
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

  let client;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: hubcode daemon start",
    };
    throw error;
  }

  try {
    try {
      const state = await client.waitForFinish(agentIdArg, timeoutMs);
      const resolvedAgentId = state.final?.id ?? agentIdArg;
      const recentActivity =
        state.status === "timeout" || state.status === "idle"
          ? await getRecentActivityTranscript(client, resolvedAgentId)
          : null;

      await client.close();

      if (state.status === "timeout") {
        const timeoutMessage = timeoutLabel
          ? `Agent did not finish within ${timeoutLabel}. Run \`hubcode wait ${resolvedAgentId}\` again to keep waiting.`
          : `Agent wait timed out. Run \`hubcode wait ${resolvedAgentId}\` again to keep waiting.`;
        return {
          type: "single",
          data: {
            agentId: resolvedAgentId,
            status: "timeout",
            message: appendRecentActivity(timeoutMessage, recentActivity),
          },
          schema: agentWaitSchema,
        };
      }

      if (state.status === "permission") {
        const permission = state.final?.pendingPermissions?.[0];
        return {
          type: "single",
          data: {
            agentId: resolvedAgentId,
            status: "permission",
            message: permission
              ? `Agent is waiting for permission: ${permission.kind}`
              : "Agent is waiting for permission",
          },
          schema: agentWaitSchema,
        };
      }

      if (state.status === "error") {
        return {
          type: "single",
          data: {
            agentId: resolvedAgentId,
            status: "error",
            message: state.error ?? "Agent finished with error",
          },
          schema: agentWaitSchema,
        };
      }

      // Agent is idle
      return {
        type: "single",
        data: {
          agentId: resolvedAgentId,
          status: "idle",
          message: appendRecentActivity("Agent is idle.", recentActivity),
        },
        schema: agentWaitSchema,
      };
    } catch (waitErr) {
      await client.close().catch(() => {});

      const waitMessage = waitErr instanceof Error ? waitErr.message : String(waitErr);

      // Other errors
      const error: CommandError = {
        code: "WAIT_FAILED",
        message: `Failed to wait for agent: ${waitMessage}`,
      };
      throw error;
    }
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "WAIT_FAILED",
      message: `Failed to wait for agent: ${message}`,
    };
    throw error;
  }
}
