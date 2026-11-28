import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, ListResult, OutputSchema } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema } from "./shared.js";

export interface WorkspaceLsOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  /** --background: Include background workspaces */
  background?: boolean;
  label?: string[];
}

function toWorkspaceListRow(workspace: WorkspaceDescriptorPayload) {
  const currentBranch = workspace.gitRuntime?.currentBranch;
  const pullRequest = workspace.githubRuntime?.pullRequest;
  return {
    ...toWorkspaceRow(workspace),
    labels: workspace.labels ?? [],
    branch:
      currentBranch === undefined
        ? (workspace.project?.checkout.currentBranch ?? null)
        : currentBranch,
    pullRequest: pullRequest
      ? {
          number: pullRequest.number ?? null,
          url: pullRequest.url,
          title: pullRequest.title,
          state: pullRequest.isMerged ? "merged" : pullRequest.state.toLowerCase(),
          isDraft: pullRequest.isDraft ?? false,
          checksStatus: pullRequest.checksStatus ?? null,
          reviewDecision: pullRequest.reviewDecision ?? null,
          mergeable: pullRequest.mergeable ?? null,
        }
      : null,
  };
}

type WorkspaceListRow = ReturnType<typeof toWorkspaceListRow>;

const workspaceListSchema: OutputSchema<WorkspaceListRow> = {
  idField: workspaceSchema.idField,
  columns: [
    ...workspaceSchema.columns,
    { header: "LABELS", field: (row) => row.labels.join(", ") },
    { header: "BRANCH", field: "branch" },
    {
      header: "PR",
      field: ({ pullRequest }) => {
        if (!pullRequest) return "";
        const state =
          pullRequest.state === "open" && pullRequest.isDraft ? "draft" : pullRequest.state;
        return pullRequest.number === null ? state : `#${pullRequest.number} ${state}`;
      },
    },
  ],
};

const workspaceListWithBackgroundSchema: OutputSchema<WorkspaceListRow> = {
  ...workspaceListSchema,
  columns: [
    ...workspaceListSchema.columns,
    { header: "BACKGROUND", field: (row) => (row.background ? "yes" : ""), width: 8 },
  ],
};

export async function runLsCommand(
  options: WorkspaceLsOptions,
  _command: Command,
): Promise<ListResult<WorkspaceListRow>> {
  const labelKeys = new Set(options.label?.map(workspaceLabelKey));
  if (labelKeys.has("")) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "--label requires a non-empty name.",
    } satisfies CommandError;
  }

  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    // COMPAT(workspaceLabels): added in v0.5.0, remove gate after 2027-08-14.
    if (labelKeys.size && client.getLastServerInfoMessage()?.features?.workspaceLabels !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to filter workspaces by label.",
      } satisfies CommandError;
    }
    const workspaces: WorkspaceListRow[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        ...(options.background ? { filter: { includeBackground: true } } : {}),
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const entries = payload.entries.filter(
        (workspace) =>
          labelKeys.size === 0 ||
          workspace.labels?.some((label) => labelKeys.has(workspaceLabelKey(label))),
      );
      workspaces.push(...entries.map(toWorkspaceListRow));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return {
      type: "list",
      data: workspaces,
      schema: options.background ? workspaceListWithBackgroundSchema : workspaceListSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
