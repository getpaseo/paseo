import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";
import { collectWorkspaces, type WorkspaceListClient } from "./shared.js";

export interface WorkspaceRenameResult {
  workspaceId: string;
  /** Display name after the rename: the title, or the derived name after --reset. */
  name: string;
  /** Raw title override; null once it has been reset to the derived name. */
  title: string | null;
}

const workspaceRenameSchema: OutputSchema<WorkspaceRenameResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "NAME", field: "name", width: 30 },
    { header: "TITLE", field: "title", width: 30 },
  ],
};

export interface WorkspaceRenameOptions {
  host?: string;
  reset?: boolean;
}

/**
 * Resolve the title to send to the daemon. Null clears the override and
 * reverts the workspace to its branch- or directory-derived name.
 */
export function resolveWorkspaceTitle(input: { title?: string; reset?: boolean }): string | null {
  const title = input.title?.trim() ?? "";
  if (input.reset) {
    if (input.title !== undefined) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--reset cannot be combined with a title",
        details: "Pass a title to rename the workspace, or --reset to revert to the derived name",
      } satisfies CommandError;
    }
    return null;
  }
  if (title.length === 0) {
    throw {
      code: "MISSING_TITLE",
      message: "Title cannot be empty",
      details: "Usage: paseo workspace rename <workspace-id> <title> | --reset",
    } satisfies CommandError;
  }
  return title;
}

export async function runRenameCommand(
  workspaceId: string,
  titleArg: string | undefined,
  options: WorkspaceRenameOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRenameResult>> {
  const title = resolveWorkspaceTitle({ title: titleArg, reset: options.reset });

  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  });
  try {
    const applied = await client.setWorkspaceTitle(workspaceId, title);
    return {
      type: "single",
      data: await resolveRenameResult(client, workspaceId, applied.title),
      schema: workspaceRenameSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_RENAME_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * The title RPC echoes the stored override, not the resolved display name, so
 * read the descriptor back to report what a reset reverted to.
 */
export async function resolveRenameResult(
  client: WorkspaceListClient,
  workspaceId: string,
  title: string | null,
): Promise<WorkspaceRenameResult> {
  const workspaces = await collectWorkspaces(client);
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  return { workspaceId, name: workspace?.name ?? title ?? "", title };
}
