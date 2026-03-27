import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  CommandError,
  OutputSchema,
  ListResult,
} from "../../output/index.js";
import type { LoopDaemonClient, LoopListItem } from "./types.js";

interface LoopListRow {
  id: string;
  name: string | null;
  status: string;
  cwd: string;
  updated: string;
  activeIteration: string;
}

export interface LoopLsOptions extends CommandOptions {}

export const loopLsSchema: OutputSchema<LoopListRow> = {
  idField: "id",
  columns: [
    { header: "LOOP ID", field: "id", width: 10 },
    { header: "NAME", field: "name", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ITER", field: "activeIteration", width: 8 },
    { header: "CWD", field: "cwd", width: 40 },
    { header: "UPDATED", field: "updated", width: 24 },
  ],
};

export function addLoopLsOptions(command: Command): Command {
  return command.description("List loops");
}

function toRow(loop: LoopListItem): LoopListRow {
  return {
    id: loop.id,
    name: loop.name,
    status: loop.status,
    cwd: loop.cwd,
    updated: loop.updatedAt,
    activeIteration: loop.activeIteration === null ? "-" : String(loop.activeIteration),
  };
}

export type LoopLsResult = ListResult<LoopListRow>;

export async function runLoopLsCommand(
  options: LoopLsOptions,
  _command: Command,
): Promise<LoopLsResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });
  let client;
  try {
    client = (await connectToDaemon({
      host: options.host as string | undefined,
    })) as unknown as LoopDaemonClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }

  try {
    const payload = await client.loopList();
    await client.close();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return {
      type: "list",
      data: payload.loops.map(toRow),
      schema: loopLsSchema,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw {
      code: "LOOP_LIST_FAILED",
      message: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}
