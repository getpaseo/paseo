import { Command } from "commander";
import { connectToDaemon, getDaemonHost, resolveAgentId } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface AgentReloadResult {
  agentId: string;
  status: "reloaded";
  timelineSize: number;
}

export const reloadSchema: OutputSchema<AgentReloadResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "TIMELINE", field: "timelineSize" },
  ],
};

export function addReloadOptions(cmd: Command): Command {
  return cmd
    .description("Reload an agent (restarts the underlying process)")
    .argument("<id>", "Agent ID, prefix, or name");
}

export interface AgentReloadOptions extends CommandOptions {
  host?: string;
}

export type AgentReloadCommandResult = SingleResult<AgentReloadResult>;

export async function runReloadCommand(
  agentIdArg: string,
  options: AgentReloadOptions,
  _command: Command,
): Promise<AgentReloadCommandResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent reload <id-or-name>",
    };
    throw error;
  }

  let client;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
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
    const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agents = agentsPayload.entries.map((entry) => entry.agent);
    const agentId = resolveAgentId(agentIdArg, agents);
    if (!agentId) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }

    const result = await client.refreshAgent(agentId);

    await client.close();

    return {
      type: "single",
      data: {
        agentId: result.agentId,
        status: "reloaded",
        timelineSize: result.timelineSize ?? 0,
      },
      schema: reloadSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "RELOAD_FAILED",
      message: `Failed to reload agent: ${message}`,
    };
    throw error;
  }
}
