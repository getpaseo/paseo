import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { openDesktopWithAgent } from "../open.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

interface OpenAgentResult {
  agentId: string;
  serverId: string;
  status: "opened";
}

const openAgentSchema: OutputSchema<OpenAgentResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "SERVER ID", field: "serverId" },
    { header: "STATUS", field: "status" },
  ],
};

export function addOpenOptions(command: Command): Command {
  return command
    .description("Open an existing agent in Paseo Desktop")
    .argument("<agent-id>", "Existing agent ID")
    .option("--server <server-id>", "Server ID (defaults to the local daemon)");
}

function toOpenError(err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "OPEN_FAILED", message: `Failed to open agent: ${message}` };
}

async function resolveAgentTarget(
  agentId: string,
  options: CommandOptions,
): Promise<AgentDeepLinkTarget> {
  const explicitServerId = typeof options.server === "string" ? options.server.trim() : "";
  if (explicitServerId) {
    return { serverId: explicitServerId, agentId };
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const serverId = client.getLastServerInfoMessage()?.serverId.trim();
    if (!serverId) {
      const error: CommandError = {
        code: "SERVER_ID_UNAVAILABLE",
        message: "The daemon did not report a server ID.",
      };
      throw error;
    }

    const fetchResult = await client.fetchAgent({ agentId });
    if (!fetchResult) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentId}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    return { serverId, agentId: fetchResult.agent.id };
  } catch (err) {
    throw toOpenError(err);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runOpenCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<OpenAgentResult>> {
  const agentId = agentIdArg.trim();
  if (!agentId) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required.",
    };
    throw error;
  }

  const target = await resolveAgentTarget(agentId, options);
  await openDesktopWithAgent(target);

  return {
    type: "single",
    data: { ...target, status: "opened" },
    schema: openAgentSchema,
  };
}
