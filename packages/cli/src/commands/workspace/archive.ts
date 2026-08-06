import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceArchiveResult {
  workspaceId: string;
  status: "archived";
  archivedAt: string;
}

const workspaceArchiveSchema: OutputSchema<WorkspaceArchiveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ARCHIVED AT", field: "archivedAt", width: 26 },
  ],
};

export async function runArchiveCommand(
  workspaceId: string,
  options: { host?: string },
  _command: Command,
): Promise<SingleResult<WorkspaceArchiveResult>> {
  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const payload = await client.archiveWorkspace(workspaceId);
    if (payload.error) {
      throw new Error(payload.error);
    }
    if (!payload.archivedAt) {
      throw new Error("Workspace archive did not return an archive timestamp");
    }
    return {
      type: "single",
      data: { workspaceId, status: "archived", archivedAt: payload.archivedAt },
      schema: workspaceArchiveSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_ARCHIVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
