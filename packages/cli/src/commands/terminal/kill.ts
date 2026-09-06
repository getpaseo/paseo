import type { Command } from "commander";
import type { CommandError, SingleResult } from "../../output/index.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalKillSchema, type TerminalKillRow } from "./schema.js";

export async function runKillCommand(
  terminalId: string,
  options: TerminalCommandOptions,
  _command: Command,
): Promise<SingleResult<TerminalKillRow>> {
  const { client, close } = await connectTerminalClient(options.host);

  try {
    const resolvedId = await requireTerminalId(client, terminalId);
    await client.terminals.ref(resolvedId).kill();
    return {
      type: "single",
      data: {
        terminalId: resolvedId,
        success: true,
      },
      schema: terminalKillSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_KILL_FAILED", "kill terminal", err);
  } finally {
    await close().catch(() => {});
  }
}

async function requireTerminalId(
  client: Awaited<ReturnType<typeof connectTerminalClient>>["client"],
  terminalId: string,
): Promise<string> {
  const resolvedId = await resolveTerminalId(client, terminalId);
  if (resolvedId) {
    return resolvedId;
  }

  const error: CommandError = {
    code: "TERMINAL_NOT_FOUND",
    message: `No terminal found matching: ${terminalId}`,
    details: "Use `paseo terminal ls --all` to list available terminals.",
  };
  throw error;
}
