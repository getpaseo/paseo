import type { Command } from "commander";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { buildDaemonOperationCommandError } from "../../utils/daemon-operation-error.js";
import {
  formatWorkspaceLabelNameForTerminal,
  resolveWorkspaceLabelName,
  withWorkspaceLabelsClient,
} from "./shared.js";

interface LabelDeleteResult {
  name: string;
  affectedWorkspaceCount: number;
}

const labelDeleteSchema: OutputSchema<LabelDeleteResult> = {
  idField: (label) => formatWorkspaceLabelNameForTerminal(label.name),
  columns: [
    {
      header: "NAME",
      field: (label) => formatWorkspaceLabelNameForTerminal(label.name),
      width: 30,
    },
    {
      header: "AFFECTED WORKSPACES",
      field: "affectedWorkspaceCount",
      width: 20,
    },
  ],
};

export async function runDeleteCommand(
  name: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<LabelDeleteResult>> {
  const normalizedName = resolveWorkspaceLabelName(name);
  return withWorkspaceLabelsClient(options, async (client) => {
    try {
      const payload = await client.deleteWorkspaceLabel({ name: normalizedName });
      // COMPAT(workspaceLabelDeleteName): added in v0.7.0, remove fallback after 2027-08-28.
      const deletedName = payload.deletedName ?? normalizedName;
      return {
        type: "single",
        data: { name: deletedName, affectedWorkspaceCount: payload.affectedWorkspaceCount },
        schema: labelDeleteSchema,
      };
    } catch (error) {
      throw buildDaemonOperationCommandError({
        code: "LABEL_DELETE_FAILED",
        action: "delete workspace label",
        error,
      });
    }
  });
}
