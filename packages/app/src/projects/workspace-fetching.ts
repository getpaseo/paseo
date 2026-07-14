import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  type EmptyProjectDescriptor,
  type WorkspaceCollection,
  normalizeEmptyProjectDescriptor,
  normalizeWorkspaceCollection,
  normalizeWorkspaceDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";

export type FetchWorkspacesClient = Pick<DaemonClient, "fetchWorkspaces">;
export type FetchWorkspacesSort = NonNullable<
  Parameters<DaemonClient["fetchWorkspaces"]>[0]
>["sort"];

export interface FetchWorkspaceDescriptorsResult {
  workspaces: WorkspaceDescriptor[];
  collections: WorkspaceCollection[];
  /**
   * Project parents with no active workspaces. The daemon only rides these on
   * the first page of `fetchWorkspaces`, so a freshly-added project that has no
   * workspace yet shows up here and nowhere else — drop it and the project is
   * invisible to anything that derives projects from workspaces alone.
   */
  emptyProjects: EmptyProjectDescriptor[];
}

export async function fetchAllWorkspaceDescriptors(input: {
  client: FetchWorkspacesClient;
  sort: FetchWorkspacesSort;
}): Promise<FetchWorkspaceDescriptorsResult> {
  const workspaces: WorkspaceDescriptor[] = [];
  const emptyProjects = new Map<string, EmptyProjectDescriptor>();
  const collections = new Map<string, WorkspaceCollection>();
  let cursor: string | null = null;

  while (true) {
    const payload = await input.client.fetchWorkspaces({
      sort: input.sort,
      page: cursor ? { limit: 200, cursor } : { limit: 200 },
    });
    workspaces.push(...payload.entries.map((entry) => normalizeWorkspaceDescriptor(entry)));
    for (const entry of payload.collections ?? []) {
      const collection = normalizeWorkspaceCollection(entry);
      collections.set(collection.id, collection);
    }
    for (const project of payload.emptyProjects ?? []) {
      const descriptor = normalizeEmptyProjectDescriptor(project);
      emptyProjects.set(descriptor.projectId, descriptor);
    }
    if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) {
      break;
    }
    cursor = payload.pageInfo.nextCursor;
  }

  return {
    workspaces,
    collections: Array.from(collections.values()),
    emptyProjects: Array.from(emptyProjects.values()),
  };
}
