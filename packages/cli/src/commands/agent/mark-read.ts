import { Command } from "commander";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import { fetchAllAgents } from "../../utils/agent-directory.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent mark-read command */
export interface MarkReadResult {
  markedCount: number;
  agentIds: string[];
}

/** Schema for mark-read command output */
export const markReadSchema: OutputSchema<MarkReadResult> = {
  // For quiet mode, output the agent IDs that were marked read (one per line)
  idField: (item) => item.agentIds.join("\n"),
  columns: [{ header: "MARKED READ", field: "markedCount" }],
};

export function addMarkReadOptions(cmd: Command): Command {
  return cmd
    .description(
      "Mark agents as read, clearing their unread or failed attention (no-op for agents already read)",
    )
    .argument("<ids...>", "Agent IDs, prefixes, or names");
}

export type AgentMarkReadOptions = CommandOptions;

export type AgentMarkReadCommandResult = SingleResult<MarkReadResult>;

export async function runMarkReadCommand(
  idArgs: string[],
  options: AgentMarkReadOptions,
  _command: Command,
): Promise<AgentMarkReadCommandResult> {
  const requested = (idArgs ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  if (requested.length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent mark-read <id-or-name>...",
    };
    throw error;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const agents = await fetchAllAgents(client);
    const resolved: string[] = [];
    for (const idArg of requested) {
      const agentId = resolveAgentId(idArg, agents);
      if (!agentId) {
        const error: CommandError = {
          code: "AGENT_NOT_FOUND",
          message: `Agent not found: ${idArg}`,
          details: 'Use "paseo ls" to list available agents',
        };
        throw error;
      }
      if (!resolved.includes(agentId)) resolved.push(agentId);
    }

    // Only agents that need attention are sent: the daemon loads each agent it
    // is asked about, so an agent that is already read is left alone.
    const unread = resolved.filter(
      (agentId) => agents.find((agent) => agent.id === agentId)?.requiresAttention === true,
    );
    if (unread.length > 0) {
      await client.clearAgentAttention(unread);
    }

    await client.close();

    return {
      type: "single",
      data: { markedCount: unread.length, agentIds: unread },
      schema: markReadSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "MARK_READ_FAILED",
      message: `Failed to mark agent as read: ${message}`,
    };
    throw error;
  }
}
