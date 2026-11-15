import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { resolveAgentEntry, type AgentLookupClient } from "../../utils/agent-directory.js";
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

export interface AgentDetachClient extends AgentLookupClient {
  detachAgent(agentId: string): Promise<unknown>;
  close(): Promise<void>;
}

export async function runDetachCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentDetachResult>> {
  return detachAgent(agentIdArg, options);
}

export async function detachAgent(
  agentIdArg: string,
  options: CommandOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<AgentDetachClient> = connectToDaemon,
): Promise<SingleResult<AgentDetachResult>> {
  const client = await connect({ target: options.daemonTarget });

  try {
    const agent = await resolveAgentEntry(client, agentIdArg);
    if (!agent) {
      throw {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
      } satisfies CommandError;
    }
    await client.detachAgent(agent.id);
    return {
      type: "single",
      data: { agentId: agent.id, status: "detached" },
      schema: detachSchema,
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DETACH_FAILED",
      message: `Failed to detach agent: ${message}`,
    } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
