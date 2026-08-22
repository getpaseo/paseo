import type { Command } from "commander";
import type { CommandError, CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

interface ProjectDeleteResult {
  projectId: string;
  removedWorkspaceIds: string[];
}

const projectDeleteSchema = {
  idField: "projectId" as const,
  columns: [
    { header: "PROJECT ID", field: "projectId" as const, width: 20 },
    {
      header: "REMOVED WORKSPACES",
      field: (result: ProjectDeleteResult) => result.removedWorkspaceIds.length,
      width: 18,
    },
  ],
};

export async function runDeleteCommand(
  projectId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<ProjectDeleteResult>> {
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  });

  try {
    const result = await client.removeProject(projectId);
    return {
      type: "single",
      data: { projectId, removedWorkspaceIds: result.removedWorkspaceIds },
      schema: projectDeleteSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROJECT_DELETE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
