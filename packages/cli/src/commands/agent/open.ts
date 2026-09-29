import type { Command } from "commander";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { openDesktopWithAgent } from "../open.js";
import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
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

export interface OpenAgentClient {
  fetchAgent(options: { agentId: string }): Promise<{ agent: { id: string } } | null>;
  getLastServerInfoMessage(): { serverId: string } | null;
  close(): Promise<void>;
}

export interface OpenCommandDeps {
  connectToDaemon: (options: ConnectOptions) => Promise<OpenAgentClient>;
  openDesktopWithAgent: (target: AgentDeepLinkTarget) => Promise<void>;
}

const defaultOpenCommandDeps: OpenCommandDeps = { connectToDaemon, openDesktopWithAgent };

const AGENT_NOT_FOUND_PREFIX = "Agent not found:";

function agentNotFoundError(message: string): CommandError {
  return {
    code: "AGENT_NOT_FOUND",
    message,
    details: 'Use "paseo ls" to list available agents',
  };
}

export function addOpenOptions(command: Command): Command {
  return command
    .description("Open an existing agent in Paseo Desktop")
    .argument("<agent-id>", "Existing agent ID")
    .option("--server <server-id>", "Server ID (defaults to the local daemon)");
}

export function runOpenCommand(
  agentIdArg: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<OpenAgentResult>> {
  return openAgent(agentIdArg, options, defaultOpenCommandDeps);
}

export async function openAgent(
  agentIdArg: string,
  options: CommandOptions,
  deps: OpenCommandDeps,
): Promise<SingleResult<OpenAgentResult>> {
  const agentId = agentIdArg.trim();
  if (!agentId) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required.",
    };
    throw error;
  }

  const explicitServerId = typeof options.server === "string" ? options.server.trim() : "";

  // With --server the agent may live on a server other than the connected
  // daemon, so a daemon that is unreachable or reports another server ID
  // means the lookup is skipped and Desktop is left to resolve the agent.
  let client: OpenAgentClient | null = null;
  try {
    client = await deps.connectToDaemon({ target: options.daemonTarget });
  } catch (err) {
    if (!explicitServerId) {
      throw err;
    }
  }

  try {
    const daemonServerId = client?.getLastServerInfoMessage()?.serverId.trim();
    const serverId = explicitServerId || daemonServerId;
    if (!serverId) {
      const error: CommandError = {
        code: "SERVER_ID_UNAVAILABLE",
        message: "The daemon did not report a server ID.",
      };
      throw error;
    }

    let resolvedAgentId = agentId;
    if (client && (!explicitServerId || explicitServerId === daemonServerId)) {
      // The daemon replies with an error string when it cannot resolve the
      // agent; only "not found" maps to AGENT_NOT_FOUND. Timeouts, dropped
      // connections and ambiguous identifiers keep their own message.
      const fetchResult = await client.fetchAgent({ agentId }).catch((err: unknown) => {
        if (err instanceof Error && err.message.startsWith(AGENT_NOT_FOUND_PREFIX)) {
          throw agentNotFoundError(err.message);
        }
        throw err;
      });
      if (!fetchResult) {
        throw agentNotFoundError(`${AGENT_NOT_FOUND_PREFIX} ${agentId}`);
      }
      resolvedAgentId = fetchResult.agent.id;
    }

    await deps.openDesktopWithAgent({ serverId, agentId: resolvedAgentId });

    return {
      type: "single",
      data: { agentId: resolvedAgentId, serverId, status: "opened" },
      schema: openAgentSchema,
    };
  } finally {
    await client?.close().catch(() => {});
  }
}
