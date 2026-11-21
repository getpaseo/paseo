import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { ListResult } from "../../output/index.js";
import {
  toWorkspaceRow,
  workspaceSchema,
  workspaceWithBackgroundSchema,
  type WorkspaceRow,
} from "./shared.js";

export interface WorkspaceLsOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  /** --background: Include background workspaces */
  background?: boolean;
}

export async function runLsCommand(
  options: WorkspaceLsOptions,
  _command: Command,
): Promise<ListResult<WorkspaceRow>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const workspaces: WorkspaceRow[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        ...(options.background ? { filter: { includeBackground: true } } : {}),
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      workspaces.push(...payload.entries.map(toWorkspaceRow));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return {
      type: "list",
      data: workspaces,
      schema: options.background ? workspaceWithBackgroundSchema : workspaceSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
