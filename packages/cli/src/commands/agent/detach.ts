import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgent } from "../../utils/agents.js";
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
    const agentId = (await resolveAgent(client, agentIdArg))?.id;
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
