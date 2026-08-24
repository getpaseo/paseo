import type { Command } from "commander";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
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

async function resolveServerId(options: CommandOptions): Promise<string> {
  const explicitServerId = typeof options.server === "string" ? options.server.trim() : "";
  if (explicitServerId) {
    return explicitServerId;
  }

  let client;
  try {
    client = await connectToDaemon({ host: options.host });
  } catch (error) {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  }
  try {
    const serverId = client.getLastServerInfoMessage()?.serverId.trim();
    if (!serverId) {
      const error: CommandError = {
        code: "SERVER_ID_UNAVAILABLE",
        message: "The daemon did not report a server ID.",
      };
      throw error;
    }
    return serverId;
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

  const serverId = await resolveServerId(options);
  await openDesktopWithAgent({ serverId, agentId });

  return {
    type: "single",
    data: { agentId, serverId, status: "opened" },
    schema: openAgentSchema,
  };
}
