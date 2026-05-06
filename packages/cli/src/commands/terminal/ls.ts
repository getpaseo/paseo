import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow, toTerminalRow } from "./schema.js";

type TerminalListEntry = Parameters<typeof toTerminalRow>[0];

export interface TerminalLsOptions extends TerminalCommandOptions {
  all?: boolean;
  cwd?: string;
}

export async function runLsCommand(
  options: TerminalLsOptions,
  _command: Command,
): Promise<ListResult<TerminalRow>> {
  const { client } = await connectTerminalClient(options.host);
  const cwd = options.all ? undefined : (options.cwd ?? process.cwd());

  try {
    const payload =
      cwd === undefined ? await client.listTerminals() : await client.listTerminals(cwd);
    return {
      type: "list",
      data: payload.terminals.map((terminal: TerminalListEntry) =>
        toTerminalRow(terminal, payload.cwd ?? cwd),
      ),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_LIST_FAILED", "list terminals", err);
  } finally {
    await client.close().catch(() => {});
  }
}
