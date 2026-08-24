import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectWorkspaceScriptClient,
  resolveWorkspaceScriptWorkspaceId,
  toWorkspaceScriptCommandError,
  type WorkspaceScriptCommandOptions,
} from "./shared.js";
import { workspaceScriptSchema, type WorkspaceScriptRow } from "./schema.js";

export async function runLsCommand(
  options: WorkspaceScriptCommandOptions,
  _command: Command,
): Promise<ListResult<WorkspaceScriptRow>> {
  const client = await connectWorkspaceScriptClient(options.host);
  try {
    const workspaceId = await resolveWorkspaceScriptWorkspaceId(client, options);
    const payload = await client.listWorkspaceScripts(workspaceId);
    if (payload.error) {
      throw new Error(payload.error);
    }
    return { type: "list", data: payload.scripts ?? [], schema: workspaceScriptSchema };
  } catch (error) {
    throw toWorkspaceScriptCommandError(
      "WORKSPACE_SCRIPT_LIST_FAILED",
      "list workspace scripts",
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
