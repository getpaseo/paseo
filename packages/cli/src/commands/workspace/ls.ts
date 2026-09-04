import type { Command } from "commander";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, ListResult } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRow } from "./shared.js";

export interface WorkspaceLsOptions {
  host?: string;
  /** Label names; a workspace must carry every one of them. */
  label?: string[];
}

/**
 * Labels match by the same key the host catalog uses, so `--label blocked`
 * finds a workspace labelled "Blocked".
 */
export function parseWorkspaceLabelFilters(labels: string[] | undefined): string[] {
  const keys: string[] = [];
  for (const label of labels ?? []) {
    const key = workspaceLabelKey(label);
    if (!key) {
      throw { code: "INVALID_LABEL", message: "--label cannot be empty" } satisfies CommandError;
    }
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

export function matchesWorkspaceLabelFilters(
  labels: readonly string[],
  labelKeys: readonly string[],
): boolean {
  if (labelKeys.length === 0) {
    return true;
  }
  const assigned = new Set(labels.map(workspaceLabelKey));
  return labelKeys.every((key) => assigned.has(key));
}

export async function runLsCommand(
  options: WorkspaceLsOptions,
  _command: Command,
): Promise<ListResult<WorkspaceRow>> {
  const labelKeys = parseWorkspaceLabelFilters(options.label);
  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    // COMPAT(workspaceLabels): added in v0.5.0, remove gate after 2027-08-14.
    if (
      labelKeys.length > 0 &&
      client.getLastServerInfoMessage()?.features?.workspaceLabels !== true
    ) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to filter workspaces by label.",
      } satisfies CommandError;
    }
    const workspaces: WorkspaceRow[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      workspaces.push(...payload.entries.map(toWorkspaceRow));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    const data = workspaces.filter((row) => matchesWorkspaceLabelFilters(row.labels, labelKeys));
    return { type: "list", data, schema: workspaceSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
