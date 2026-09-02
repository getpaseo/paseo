import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { Command } from "commander";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { buildDaemonOperationCommandError } from "../../utils/daemon-operation-error.js";
import {
  CLI_WORKSPACE_LABEL_SUBSCRIPTION_ID,
  formatWorkspaceLabelNameForTerminal,
  resolveWorkspaceLabelName,
  withWorkspaceLabelsClient,
} from "./shared.js";

interface WorkspaceLabelAssignmentResult {
  workspaceId: string;
  label: string;
  assigned: boolean;
  workspaceLabels: string[];
}

interface SetWorkspaceLabelOptions {
  workspaceId: string;
  name: string;
  assigned: boolean;
  host?: string;
}

const workspaceLabelAssignmentSchema: OutputSchema<WorkspaceLabelAssignmentResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    {
      header: "LABEL",
      field: (result) => formatWorkspaceLabelNameForTerminal(result.label),
      width: 24,
    },
    { header: "ASSIGNED", field: "assigned", width: 10 },
    {
      header: "WORKSPACE LABELS",
      field: (result) => result.workspaceLabels.map(formatWorkspaceLabelNameForTerminal).join(", "),
      width: 30,
    },
  ],
};

async function resolveCatalogLabel(client: DaemonClient, name: string) {
  const payload = await client.listWorkspaceLabels({
    subscriptionId: CLI_WORKSPACE_LABEL_SUBSCRIPTION_ID,
  });
  const key = workspaceLabelKey(name);
  const label = payload.labels.find((candidate) => workspaceLabelKey(candidate.name) === key);
  if (!label) {
    const displayName = formatWorkspaceLabelNameForTerminal(name);
    throw {
      code: "LABEL_NOT_FOUND",
      message: `Workspace label not found: ${displayName}`,
      details: `Create it first with: paseo label create ${JSON.stringify(displayName)}`,
    } satisfies CommandError;
  }
  return label;
}

async function runSetWorkspaceLabelCommand(
  input: SetWorkspaceLabelOptions,
): Promise<SingleResult<WorkspaceLabelAssignmentResult>> {
  const name = resolveWorkspaceLabelName(input.name);
  return withWorkspaceLabelsClient({ host: input.host }, async (client) => {
    try {
      const label = await resolveCatalogLabel(client, name);
      const payload = await client.setWorkspaceLabel({
        workspaceId: input.workspaceId,
        label,
        assigned: input.assigned,
      });
      return {
        type: "single",
        data: {
          workspaceId: input.workspaceId,
          label: payload.label.name,
          assigned: input.assigned,
          workspaceLabels: payload.workspaceLabels,
        },
        schema: workspaceLabelAssignmentSchema,
      };
    } catch (error) {
      throw buildDaemonOperationCommandError({
        code: input.assigned ? "WORKSPACE_LABEL_ADD_FAILED" : "WORKSPACE_LABEL_REMOVE_FAILED",
        action: `${input.assigned ? "add label to" : "remove label from"} workspace`,
        error,
      });
    }
  });
}

export async function runAddWorkspaceLabelCommand(
  workspaceId: string,
  name: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceLabelAssignmentResult>> {
  return runSetWorkspaceLabelCommand({
    workspaceId,
    name,
    assigned: true,
    host: options.host,
  });
}

export async function runRemoveWorkspaceLabelCommand(
  workspaceId: string,
  name: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceLabelAssignmentResult>> {
  return runSetWorkspaceLabelCommand({
    workspaceId,
    name,
    assigned: false,
    host: options.host,
  });
}

export function createWorkspaceLabelAssignmentCommand(): Command {
  const label = new Command("label").description("Manage labels assigned to a workspace");

  addJsonAndDaemonHostOptions(
    label
      .command("add")
      .description("Add an existing label to a workspace")
      .argument("<workspace-id>", "Workspace id")
      .argument("<label>", "Workspace label name")
      .allowExcessArguments(false),
  ).action(withOutput(runAddWorkspaceLabelCommand));

  addJsonAndDaemonHostOptions(
    label
      .command("remove")
      .description("Remove a label from a workspace")
      .argument("<workspace-id>", "Workspace id")
      .argument("<label>", "Workspace label name")
      .allowExcessArguments(false),
  ).action(withOutput(runRemoveWorkspaceLabelCommand));

  return label;
}
