import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export interface TerminalLsOptions extends TerminalCommandOptions {
  workspace?: string;
  all?: boolean;
  cwd?: string;
}

export async function runLsCommand(
  options: TerminalLsOptions,
  _command: Command,
): Promise<ListResult<TerminalRow>> {
  const { client, close } = await connectTerminalClient(options.host);
  const cwd = options.all || options.workspace ? undefined : (options.cwd ?? process.cwd());

  try {
    const payload = await client.terminals.list({ cwd, workspaceId: options.workspace });
    return {
      type: "list",
      data: payload.entries,
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    await close().catch(() => {});
  }
}
