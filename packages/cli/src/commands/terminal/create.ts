import type { Command } from "commander";
import type { SingleResult, CommandError } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow, toTerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  cwd?: string;
  name?: string;
}

export async function runCreateCommand(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client } = await connectTerminalClient(options.host);
  const cwd = options.cwd ?? process.cwd();

  try {
    const opened = await client.openProject(cwd);
    if (!opened.workspace) {
      const error: CommandError = {
        code: "WORKSPACE_OPEN_FAILED",
        message: opened.error ?? "Failed to open workspace",
      };
      throw error;
    }

    const payload = await client.createTerminal(cwd, options.name, undefined, {
      workspaceId: opened.workspace.id,
    });
    if (!payload.terminal) {
      const error: CommandError = {
        code: "TERMINAL_CREATE_FAILED",
        message: payload.error ?? "Failed to create terminal",
      };
      throw error;
    }
    return {
      type: "single",
      data: toTerminalRow(payload.terminal),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await client.close().catch(() => {});
  }
}
