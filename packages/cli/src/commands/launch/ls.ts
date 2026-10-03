import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectWorkspaceLaunchClient,
  resolveWorkspaceLaunchWorkspaceId,
  toWorkspaceLaunchCommandError,
  type WorkspaceLaunchCommandOptions,
} from "./shared.js";
import { workspaceLaunchSchema, type WorkspaceLaunchRow } from "./schema.js";

export async function runLsCommand(
  options: WorkspaceLaunchCommandOptions,
  _command: Command,
): Promise<ListResult<WorkspaceLaunchRow>> {
  const client = await connectWorkspaceLaunchClient(options.host);
  try {
    const workspaceId = await resolveWorkspaceLaunchWorkspaceId(client, options);
    const payload = await client.listWorkspaceLaunches(workspaceId);
    if (payload.error) throw new Error(payload.error);
    return { type: "list", data: payload.launches ?? [], schema: workspaceLaunchSchema };
  } catch (error) {
    throw toWorkspaceLaunchCommandError(
      "WORKSPACE_LAUNCH_LIST_FAILED",
      "list workspace launches",
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
