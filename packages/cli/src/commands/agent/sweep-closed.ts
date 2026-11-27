import type { Command } from "commander";
import type { CommandOptions } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";

const TRANSIENT_DAEMON_ERRORS = new Set([
  "DAEMON_CONNECTION_LOST",
  "DAEMON_NOT_READY",
  "DAEMON_NOT_RUNNING",
  "DAEMON_REPLACED",
  "DAEMON_REQUEST_TIMEOUT",
  "DAEMON_UNREACHABLE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

export async function runSweepClosedCommand(
  options: CommandOptions,
  _command: Command,
): Promise<void> {
  let client: Awaited<ReturnType<typeof connectToDaemon>> | undefined;
  try {
    client = await connectToDaemon({ target: options.daemonTarget });
    if (client.getLastServerInfoMessage()?.features?.archiveStaleClosedAgent !== true) {
      return;
    }
    const agentIds = await client.listStaleClosedAgentIds();
    for (const agentId of agentIds) {
      await client.archiveStaleClosedAgent(agentId);
    }
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !TRANSIENT_DAEMON_ERRORS.has(error.code)
    ) {
      throw error;
    }
  } finally {
    await client?.close();
  }
}
