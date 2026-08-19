import type { Command } from "commander";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

interface ProjectRenameResult {
  projectId: string;
  name: string | null;
}

const projectRenameSchema = {
  idField: "projectId" as const,
  columns: [
    { header: "PROJECT ID", field: "projectId" as const, width: 20 },
    { header: "NAME", field: "name" as const, width: 30 },
  ],
};

export function resolveProjectName(input: { name?: string; reset?: boolean }): string | null {
  if (input.reset) {
    if (input.name !== undefined) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--reset cannot be combined with a name",
      } satisfies CommandError;
    }
    return null;
  }

  const name = input.name?.trim() ?? "";
  if (name.length === 0) {
    throw {
      code: "MISSING_NAME",
      message: "Project name cannot be empty",
      details: "Usage: paseo project rename <project-id> <name> | --reset",
    } satisfies CommandError;
  }
  return name;
}

export async function runRenameCommand(
  projectId: string,
  nameArg: string | undefined,
  options: CommandOptions & { reset?: boolean },
  _command: Command,
): Promise<SingleResult<ProjectRenameResult>> {
  const name = resolveProjectName({ name: nameArg, reset: options.reset });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  });

  try {
    const applied = await client.renameProject(projectId, name);
    return {
      type: "single",
      data: { projectId, name: applied.customName },
      schema: projectRenameSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_RENAME_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
