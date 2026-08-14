import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost, resolveAgentId } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface AgentUnarchiveResult {
  agentId: string;
  status: "unarchived";
  timelineSize: number;
}

export const unarchiveSchema: OutputSchema<AgentUnarchiveResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "TIMELINE", field: "timelineSize" },
  ],
};

export function addUnarchiveOptions(cmd: Command): Command {
  return cmd
    .description("Unarchive and reload an agent")
    .argument("<id>", "Agent ID, prefix, or name");
}

export interface AgentUnarchiveOptions extends CommandOptions {
  host?: string;
}

export type AgentUnarchiveCommandResult = SingleResult<AgentUnarchiveResult>;

export async function runUnarchiveCommand(
  agentIdArg: string,
  options: AgentUnarchiveOptions,
  _command: Command,
): Promise<AgentUnarchiveCommandResult> {
  const host = getDaemonHost({ host: options.host });

  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent unarchive <id-or-name>",
    };
    throw error;
  }

  let client: DaemonClient;
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
    const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agents = agentsPayload.entries.map((entry) => entry.agent);
    const agentId = resolveAgentId(agentIdArg, agents);
    if (!agentId) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls --all" to list archived agents',
      };
      throw error;
    }

    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Resolved agent missing from fetched agents: ${agentId}`);
    }
    if (!agent.archivedAt) {
      const error: CommandError = {
        code: "AGENT_NOT_ARCHIVED",
        message: `Agent ${agentId.slice(0, 7)} is not archived`,
        details: "Only archived agents can be unarchived",
      };
      throw error;
    }

    const result = await client.refreshAgent(agentId);

    await client.close();

    return {
      type: "single",
      data: {
        agentId: result.agentId,
        status: "unarchived",
        timelineSize: result.timelineSize ?? 0,
      },
      schema: unarchiveSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "UNARCHIVE_FAILED",
      message: `Failed to unarchive agent: ${message}`,
    };
    throw error;
  }
}
