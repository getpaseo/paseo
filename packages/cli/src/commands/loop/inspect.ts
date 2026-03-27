import { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  CommandError,
  OutputSchema,
  ListResult,
} from "../../output/index.js";
import type { LoopDaemonClient, LoopRecord } from "./types.js";

interface InspectRow {
  key: string;
  value: string;
}

export interface LoopInspectOptions extends CommandOptions {}

export function addLoopInspectOptions(command: Command): Command {
  return command.description("Show loop details and iteration history").argument("<id>", "Loop ID");
}

function createInspectSchema(loop: LoopRecord): OutputSchema<InspectRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key", width: 18 },
      { header: "VALUE", field: "value", width: 80 },
    ],
    serialize: () => loop,
  };
}

function toRows(loop: LoopRecord): InspectRow[] {
  return [
    { key: "Id", value: loop.id },
    { key: "Name", value: loop.name ?? "null" },
    { key: "Status", value: loop.status },
    { key: "Cwd", value: loop.cwd },
    { key: "Provider", value: loop.provider },
    { key: "Prompt", value: loop.prompt },
    { key: "VerifyPrompt", value: loop.verifyPrompt ?? "null" },
    { key: "VerifyChecks", value: loop.verifyChecks.length > 0 ? loop.verifyChecks.join(" | ") : "[]" },
    { key: "SleepMs", value: String(loop.sleepMs) },
    { key: "MaxIterations", value: loop.maxIterations === null ? "null" : String(loop.maxIterations) },
    { key: "MaxTimeMs", value: loop.maxTimeMs === null ? "null" : String(loop.maxTimeMs) },
    { key: "CreatedAt", value: loop.createdAt },
    { key: "UpdatedAt", value: loop.updatedAt },
    { key: "CompletedAt", value: loop.completedAt ?? "null" },
    {
      key: "Iterations",
      value:
        loop.iterations.length === 0
          ? "[]"
          : loop.iterations
              .map((iteration) => {
                const summary = [
                  `#${iteration.index}`,
                  iteration.status,
                  iteration.workerAgentId ? `worker=${iteration.workerAgentId}` : null,
                  iteration.verifierAgentId ? `verifier=${iteration.verifierAgentId}` : null,
                  iteration.failureReason ? `reason=${iteration.failureReason}` : null,
                ]
                  .filter(Boolean)
                  .join(" ");
                return summary;
              })
              .join(" | "),
    },
  ];
}

export type LoopInspectResult = ListResult<InspectRow>;

export async function runLoopInspectCommand(
  id: string,
  options: LoopInspectOptions,
  _command: Command,
): Promise<LoopInspectResult> {
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
    const payload = await client.loopInspect(id);
    await client.close();
    if (payload.error || !payload.loop) {
      throw new Error(payload.error ?? `Loop not found: ${id}`);
    }
    return {
      type: "list",
      data: toRows(payload.loop),
      schema: createInspectSchema(payload.loop),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw {
      code: "LOOP_INSPECT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    } satisfies CommandError;
  }
}
