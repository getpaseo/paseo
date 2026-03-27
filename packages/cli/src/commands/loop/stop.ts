import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  CommandError,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import type { LoopDaemonClient, LoopRecord } from "./types.js";

interface LoopStopRow {
  id: string;
  status: string;
  activeIteration: string;
}

export interface LoopStopOptions extends CommandOptions {}

export const loopStopSchema: OutputSchema<LoopStopRow> = {
  idField: "id",
  columns: [
    { header: "LOOP ID", field: "id", width: 10 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ITER", field: "activeIteration", width: 8 },
  ],
};

export function addLoopStopOptions(command: Command): Command {
  return command.description("Stop a running loop").argument("<id>", "Loop ID");
}

function toRow(loop: LoopRecord): LoopStopRow {
  return {
    id: loop.id,
    status: loop.status,
    activeIteration: loop.activeIteration === null ? "-" : String(loop.activeIteration),
  };
}

export type LoopStopResult = SingleResult<LoopStopRow>;

export async function runLoopStopCommand(
  id: string,
  options: LoopStopOptions,
  _command: Command,
): Promise<LoopStopResult> {
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
    const payload = await client.loopStop(id);
    await client.close();
    if (payload.error || !payload.loop) {
      throw new Error(payload.error ?? `Loop not found: ${id}`);
    }
    return {
      type: "single",
      data: toRow(payload.loop),
      schema: loopStopSchema,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw {
      code: "LOOP_STOP_FAILED",
      message: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}
