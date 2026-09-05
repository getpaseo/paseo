import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  workspace?: string;
  cwd?: string;
  name?: string;
}

export async function runCreateCommand(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client, close } = await connectTerminalClient(options.host);
  try {
    const cwd = options.cwd ?? (options.workspace ? undefined : process.cwd());
    const workspaceId =
      options.workspace ?? (await client.workspaces.open(options.cwd ?? process.cwd())).id;
    const terminal = await client.terminals.create({
      workspaceId,
      cwd,
      name: options.name,
    });
    const snapshot = terminal.current();
    if (!snapshot) throw new Error("The daemon did not create a terminal");
    return {
      type: "single",
      data: snapshot,
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await close().catch(() => {});
  }
}
