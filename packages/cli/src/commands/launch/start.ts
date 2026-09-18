import type { Command } from "commander";
import type { CommandError, SingleResult } from "../../output/index.js";
import {
  connectWorkspaceLaunchClient,
  resolveWorkspaceLaunchWorkspaceId,
  toWorkspaceLaunchCommandError,
  type WorkspaceLaunchCommandOptions,
} from "./shared.js";
import { workspaceLaunchSchema, type WorkspaceLaunchRow } from "./schema.js";

export async function runStartCommand(
  launchName: string,
  options: WorkspaceLaunchCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceLaunchRow>> {
  const client = await connectWorkspaceLaunchClient(options.host);
  try {
    const workspaceId = await resolveWorkspaceLaunchWorkspaceId(client, options);
    const payload = await client.startWorkspaceLaunch(workspaceId, launchName);
    if (payload.error || !payload.launch) {
      throw {
        code: "WORKSPACE_LAUNCH_START_FAILED",
        message: payload.error ?? `Launch '${launchName}' did not return status metadata`,
      } satisfies CommandError;
    }
    return { type: "single", data: payload.launch, schema: workspaceLaunchSchema };
  } catch (error) {
    throw toWorkspaceLaunchCommandError(
      "WORKSPACE_LAUNCH_START_FAILED",
      "start workspace launch",
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
