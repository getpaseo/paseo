import type { Command } from "commander";
import type { CommandOptions, ListResult } from "../../output/index.js";
import { buildDaemonOperationCommandError } from "../../utils/daemon-operation-error.js";
import {
  CLI_WORKSPACE_LABEL_SUBSCRIPTION_ID,
  withWorkspaceLabelsClient,
  workspaceLabelSchema,
  type WorkspaceLabelRow,
} from "./shared.js";

export async function runLsCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<WorkspaceLabelRow>> {
  return withWorkspaceLabelsClient(options, async (client) => {
    try {
      const payload = await client.listWorkspaceLabels({
        subscriptionId: CLI_WORKSPACE_LABEL_SUBSCRIPTION_ID,
      });
      const labels = payload.labels.map(({ name, color }) => ({ name, color }));
      labels.sort((left, right) => left.name.localeCompare(right.name));
      return { type: "list", data: labels, schema: workspaceLabelSchema };
    } catch (error) {
      throw buildDaemonOperationCommandError({
        code: "LABEL_LIST_FAILED",
        action: "list workspace labels",
        error,
      });
    }
  });
}
