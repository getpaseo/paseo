import path from "node:path";
import type { Command } from "commander";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import { projectSchema, toProjectRow, type ProjectRow } from "./shared.js";

export async function runCreateCommand(
  pathArg: string | undefined,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ProjectRow>> {
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  });

  try {
    const payload = await client.addProject(path.resolve(pathArg ?? process.cwd()));
    if (!payload.project) {
      throw new Error(payload.error ?? "Project creation failed");
    }
    return { type: "single", data: toProjectRow(payload.project), schema: projectSchema };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_CREATE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
