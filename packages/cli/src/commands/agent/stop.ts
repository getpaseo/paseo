import { Command } from "commander";
import type { DaemonClient } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { isSameOrDescendantPath } from "../../utils/paths.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent stop command */
export interface StopResult {
  stoppedCount: number;
  agentIds: string[];
}

/** Schema for stop command output */
export const stopSchema: OutputSchema<StopResult> = {
  // For quiet mode, output the stopped agent IDs (one per line)
  idField: (item) => item.agentIds.join("\n"),
  columns: [{ header: "INTERRUPTED", field: "stoppedCount" }],
};

export function addStopOptions(cmd: Command): Command {
  return cmd
    .description("Interrupt an agent if it is running (no-op for idle agents)")
    .argument("[id]", "Agent ID (or prefix) - optional if --all or --cwd specified")
    .option("--all", "Stop all agents")
    .option("--cwd <path>", "Stop all agents in directory");
}

export interface AgentStopOptions extends CommandOptions {
  all?: boolean;
  cwd?: string;
}

export type AgentStopResult = SingleResult<StopResult>;

export async function runStopCommand(
  id: string | undefined,
  options: AgentStopOptions,
  _command: Command,
): Promise<AgentStopResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  // Validate arguments - need either an id, --all, or --cwd
  if (!id && !options.all && !options.cwd) {
    const error: CommandError = {
      code: "MISSING_ARGUMENT",
      message: "Agent ID required unless --all or --cwd is specified",
      details: "Usage: paseo agent stop <id> | --all | --cwd <path>",
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
    const stoppedIds: string[] = [];

    if (options.all) {
      // Stop all agents (not archived)
      agents = agents.filter((a) => !a.archivedAt);
    } else if (options.cwd) {
      // Stop agents in directory
      agents = agents.filter((a) => {
        if (a.archivedAt) return false;
        return isSameOrDescendantPath(options.cwd!, a.cwd);
      });
    } else if (id) {
      // Stop specific agent
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

    // Interrupt each running agent. Idle agents are a no-op.
    const stopResults = await Promise.all(
      agents.map(async (agent) => {
        if (agent.status !== "running") return { ok: true as const, id: agent.id, stopped: false };
        try {
          await client.cancelAgent(agent.id);
          return { ok: true as const, id: agent.id, stopped: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false as const, id: agent.id, message };
        }
      }),
    );
    for (const result of stopResults) {
      if (!result.ok) {
        console.error(`Warning: Failed to stop agent ${result.id.slice(0, 7)}: ${result.message}`);
        continue;
      }
      if (result.stopped) {
        stoppedIds.push(result.id);
      }
    }

    await client.close();

    return {
      type: "single",
      data: {
        stoppedCount: stoppedIds.length,
        agentIds: stoppedIds,
      },
      schema: stopSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});
    // Re-throw if it's already a CommandError
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "STOP_AGENT_FAILED",
      message: `Failed to stop agent(s): ${message}`,
    };
    throw error;
  }
}
