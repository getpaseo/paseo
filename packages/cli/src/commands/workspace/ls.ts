import type { Command } from "commander";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, ListResult } from "../../output/index.js";
import { toWorkspaceRow, workspaceSchema, type WorkspaceRow } from "./shared.js";

export async function runLsCommand(
  options: { host?: string; daemonTarget: import("../../utils/daemon-target.js").DaemonTarget },
  _command: Command,
): Promise<ListResult<WorkspaceRow>> {
  const host = getDaemonHost({ target: options.daemonTarget });
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });
  try {
    const workspaces: WorkspaceRow[] = [];
    let cursor: string | undefined;
    do {
      const payload = await client.fetchWorkspaces({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      workspaces.push(...payload.entries.map(toWorkspaceRow));
      cursor = payload.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return { type: "list", data: workspaces, schema: workspaceSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
