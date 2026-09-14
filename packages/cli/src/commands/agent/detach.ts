import type { Command } from "commander";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface AgentDetachResult {
  agentId: string;
  status: "detached";
}

const detachSchema: OutputSchema<AgentDetachResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
  ],
};

export async function runDetachCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentDetachResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const payload = await client.fetchAgents({ filter: { includeArchived: true } });
    const agentId = resolveAgentId(
      agentIdArg,
      payload.entries.map((entry) => entry.agent),
    );
    if (!agentId) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
      } satisfies CommandError;
    }
    await client.detachAgent(agentId);
    return { type: "single", data: { agentId, status: "detached" }, schema: detachSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
