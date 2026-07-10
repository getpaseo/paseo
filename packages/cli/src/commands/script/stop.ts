import type { Command } from "commander";
import type { CommandError, SingleResult } from "../../output/index.js";
import {
  connectWorkspaceScriptClient,
  resolveWorkspaceScriptWorkspaceId,
  toWorkspaceScriptCommandError,
  type WorkspaceScriptCommandOptions,
} from "./shared.js";
import { workspaceScriptSchema, type WorkspaceScriptRow } from "./schema.js";

export async function runStopCommand(
  scriptName: string,
  options: WorkspaceScriptCommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceScriptRow>> {
  const client = await connectWorkspaceScriptClient(options.host);
  try {
    const workspaceId = await resolveWorkspaceScriptWorkspaceId(client, options);
    const payload = await client.stopWorkspaceScript(workspaceId, scriptName);
    if (payload.error || !payload.script) {
      throw {
        code: "WORKSPACE_SCRIPT_STOP_FAILED",
        message: payload.error ?? `Script '${scriptName}' did not return status metadata`,
      } satisfies CommandError;
    }
    return { type: "single", data: payload.script, schema: workspaceScriptSchema };
  } catch (error) {
    throw toWorkspaceScriptCommandError(
      "WORKSPACE_SCRIPT_STOP_FAILED",
      "stop workspace script",
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
