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

function parseWaitTimeout(timeout: string | undefined): {
  timeoutMs: number;
  timeoutLabel: string | null;
} {
  if (!timeout) return { timeoutMs: 0, timeoutLabel: null };
  try {
    const ms = parseDuration(timeout);
    if (ms <= 0) {
      throw new Error("Timeout must be positive");
    }
    const timeoutSeconds = Math.floor(ms / 1000);
    return {
      timeoutMs: ms,
      timeoutLabel: `${timeoutSeconds} second${timeoutSeconds === 1 ? "" : "s"}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "INVALID_TIMEOUT",
      message: "Invalid timeout value",
      details: message,
    } satisfies CommandError;
  }
}

type WaitFinishState = Awaited<
  ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["waitForFinish"]>
>;

function buildWaitResult(args: {
  state: WaitFinishState;
  resolvedAgentId: string;
  recentActivity: string | null;
  timeoutLabel: string | null;
}): AgentWaitResult {
  const { state, resolvedAgentId, recentActivity, timeoutLabel } = args;

  if (state.status === "timeout") {
    const timeoutMessage = timeoutLabel
      ? `Agent did not finish within ${timeoutLabel}. Run \`paseo wait ${resolvedAgentId}\` again to keep waiting.`
      : `Agent wait timed out. Run \`paseo wait ${resolvedAgentId}\` again to keep waiting.`;
    return {
      agentId: resolvedAgentId,
      status: "timeout",
      message: appendRecentActivity(timeoutMessage, recentActivity),
    };
  }

  if (state.status === "permission") {
    const permission = state.final?.pendingPermissions?.[0];
    return {
      agentId: resolvedAgentId,
      status: "permission",
      message: permission
        ? `Agent is waiting for permission: ${permission.kind}`
        : "Agent is waiting for permission",
    };
  }

  if (state.status === "error") {
    return {
      agentId: resolvedAgentId,
      status: "error",
      message: state.error ?? "Agent finished with error",
    };
  }

  return {
    agentId: resolvedAgentId,
    status: "idle",
    message: appendRecentActivity("Agent is idle.", recentActivity),
  };
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
  const host = getDaemonHost({ host: options.host });

  if (!agentIdArg || agentIdArg.trim().length === 0) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent wait <id>",
    } satisfies CommandError;
  }

  const { timeoutMs, timeoutLabel } = parseWaitTimeout(options.timeout);

  let client;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
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

      return {
        type: "single",
        data: buildWaitResult({ state, resolvedAgentId, recentActivity, timeoutLabel }),
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
