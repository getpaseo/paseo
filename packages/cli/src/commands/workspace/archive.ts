import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

export interface WorkspaceArchiveResult {
  workspaceId: string;
  status: "archived";
  archivedAt: string;
  removedAgents: string[];
}

export interface WorkspaceArchiveCommandError extends CommandError {
  removedAgents: string[];
}

const workspaceArchiveSchema: OutputSchema<WorkspaceArchiveResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "ARCHIVED AT", field: "archivedAt", width: 26 },
    {
      header: "REMOVED AGENTS",
      field: (item) => (item.removedAgents.length > 0 ? item.removedAgents.join(", ") : "-"),
    },
  ],
};

export async function runArchiveCommand(
  workspaceId: string,
  options: { host?: string },
  _command: Command,
): Promise<SingleResult<WorkspaceArchiveResult>> {
  return runArchiveCommandWithDeps(workspaceId, options, { connectToDaemon });
}

export async function runArchiveCommandWithDeps(
  workspaceId: string,
  options: { host?: string },
  deps: { connectToDaemon: typeof connectToDaemon },
): Promise<SingleResult<WorkspaceArchiveResult>> {
  const host = getDaemonHost({ host: options.host });
  const client: DaemonClient = await deps
    .connectToDaemon({ host: options.host })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw {
        code: "DAEMON_NOT_RUNNING",
        message: `Cannot connect to daemon at ${host}: ${message}`,
      } satisfies CommandError;
    });
  try {
    const payload = await client.archiveWorkspace(workspaceId);
    const removedAgents = Array.from(new Set(payload.removedAgents ?? []));
    if (payload.error) {
      throw {
        code: "WORKSPACE_ARCHIVE_FAILED",
        message: payload.error,
        removedAgents,
        ...(removedAgents.length > 0
          ? { details: `Archived agents before failure: ${removedAgents.join(", ")}` }
          : {}),
      } satisfies WorkspaceArchiveCommandError;
    }
    if (!payload.archivedAt) {
      throw new Error("Workspace archive did not return an archive timestamp");
    }
    return {
      type: "single",
      data: {
        workspaceId,
        status: "archived",
        archivedAt: payload.archivedAt,
        removedAgents,
      },
      schema: workspaceArchiveSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_ARCHIVE_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
