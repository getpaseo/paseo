import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";

export type FetchWorkspacesClient = Pick<DaemonClient, "fetchWorkspaces">;
export type FetchWorkspacesSort = NonNullable<
  Parameters<DaemonClient["fetchWorkspaces"]>[0]
>["sort"];

export async function fetchAllWorkspaceDescriptors(input: {
  client: FetchWorkspacesClient;
  sort: FetchWorkspacesSort;
}): Promise<WorkspaceDescriptor[]> {
  const entries: WorkspaceDescriptor[] = [];
  let cursor: string | null = null;

  while (true) {
    const payload = await input.client.fetchWorkspaces({
      sort: input.sort,
      page: cursor ? { limit: 200, cursor } : { limit: 200 },
    });
    entries.push(...payload.entries.map((entry) => normalizeWorkspaceDescriptor(entry)));
    if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
      break;
    }
    cursor = payload.pageInfo.nextCursor;
  }

  return entries;
}
