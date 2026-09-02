import type { Command } from "commander";
import type { CommandOptions, SingleResult } from "../../output/index.js";
import { buildDaemonOperationCommandError } from "../../utils/daemon-operation-error.js";
import {
  resolveWorkspaceLabelColor,
  resolveWorkspaceLabelName,
  withWorkspaceLabelsClient,
  workspaceLabelSchema,
  type WorkspaceLabelRow,
} from "./shared.js";

export interface LabelCreateOptions extends CommandOptions {
  color?: string;
}

export async function runCreateCommand(
  nameArg: string,
  options: LabelCreateOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceLabelRow>> {
  const name = resolveWorkspaceLabelName(nameArg);
  const color = resolveWorkspaceLabelColor(options.color);

  return withWorkspaceLabelsClient({ host: options.host, requiresCreate: true }, async (client) => {
    try {
      const payload = await client.createWorkspaceLabel({ name, color });
      return {
        type: "single",
        data: { name: payload.label.name, color: payload.label.color },
        schema: workspaceLabelSchema,
      };
    } catch (error) {
      throw buildDaemonOperationCommandError({
        code: "LABEL_CREATE_FAILED",
        action: "create workspace label",
        error,
      });
    }
  });
}
