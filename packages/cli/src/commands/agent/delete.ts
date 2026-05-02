import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { isSameOrDescendantPath } from "../../utils/paths.js";

export function addDeleteOptions(cmd: Command): Command {
  return cmd
    .description("Delete an agent (interrupt if running, then hard-delete)")
    .argument("[id]", "Agent ID (or prefix) - optional if --all or --cwd specified")
    .option("--all", "Delete all agents")
    .option("--cwd <path>", "Delete all agents in directory");
}
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface DeleteResult {
  deletedCount: number;
  agentIds: string[];
}

export const deleteSchema: OutputSchema<DeleteResult> = {
  idField: (item) => item.agentIds.join("\n"),
  columns: [{ header: "DELETED", field: "deletedCount" }],
};

export interface AgentDeleteOptions extends CommandOptions {
  all?: boolean;
  cwd?: string;
}

export type AgentDeleteResult = SingleResult<DeleteResult>;

export async function runDeleteCommand(
  id: string | undefined,
  options: AgentDeleteOptions,
  _command: Command,
): Promise<AgentDeleteResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  if (!id && !options.all && !options.cwd) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Agent ID required unless --all or --cwd is specified",
      details: "Usage: paseo agent delete <id> | --all | --cwd <path>",
    };
    throw error;
  }

  let client: DaemonClient;
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
    const fetchPayload = await client.fetchAgents({ filter: { includeArchived: true } });
    let agents = fetchPayload.entries.map((entry) => entry.agent);
    const deletedIds: string[] = [];

    if (options.all) {
      agents = agents.filter((a) => !a.archivedAt);
    } else if (options.cwd) {
      agents = agents.filter((a) => {
        if (a.archivedAt) return false;
        return isSameOrDescendantPath(options.cwd!, a.cwd);
      });
    } else if (id) {
      const fetchResult = await client.fetchAgent(id);
      if (!fetchResult) {
        const error: CommandError = {
          code: "AGENT_NOT_FOUND",
          message: `No agent found matching: ${id}`,
          details: "Use `paseo ls` to list available agents",
        };
        throw error;
      }
      agents = [fetchResult.agent];
    }

    const deleteResults = await Promise.all(
      agents.map(async (agent) => {
        try {
          if (agent.status === "running") {
            await client.cancelAgent(agent.id);
          }
          await client.deleteAgent(agent.id);
          return { ok: true as const, id: agent.id };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false as const, id: agent.id, message };
        }
      }),
    );
    for (const result of deleteResults) {
      if (result.ok) {
        deletedIds.push(result.id);
      } else {
        console.error(
          `Warning: Failed to delete agent ${result.id.slice(0, 7)}: ${result.message}`,
        );
      }
    }

    await client.close();

    return {
      type: "single",
      data: {
        deletedCount: deletedIds.length,
        agentIds: deletedIds,
      },
      schema: deleteSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DELETE_AGENT_FAILED",
      message: `Failed to delete agent(s): ${message}`,
    };
    throw error;
  }
}
