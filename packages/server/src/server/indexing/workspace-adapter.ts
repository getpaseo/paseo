import { promises as fs } from "node:fs";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { IndexingWorkspaceAdapter } from "./service.js";
import type { IndexingState } from "./types.js";

/**
 * Bridges the file-backed `WorkspaceRegistry` to the narrow surface
 * `IndexingService` needs. Keeps the service unaware of the full workspace
 * record shape so its tests can use a tiny in-memory map.
 */
export function createWorkspaceIndexingAdapter(
  registry: WorkspaceRegistry,
  options: { dirExists?: (cwd: string) => Promise<boolean> } = {},
): IndexingWorkspaceAdapter {
  const dirExists = options.dirExists ?? defaultDirExists;
  return {
    async list() {
      const all = await registry.list();
      // Hide:
      //   - archived workspaces (sidebar's archived section, not active list)
      //   - workspaces whose cwd no longer exists on disk (orphan worktrees,
      //     deleted clones) — letting users toggle indexing on dead paths
      //     would just emit errors and pollute the UI.
      const candidates = all.filter((record) => record.archivedAt === null);
      const checks = await Promise.all(
        candidates.map(async (record) => ((await dirExists(record.cwd)) ? record : null)),
      );
      return checks
        .filter((r): r is PersistedWorkspaceRecord => r !== null)
        .map((record) => ({
          workspaceId: record.workspaceId,
          indexing: record.indexing,
        }));
    },
    async get(workspaceId: string) {
      const record = await registry.get(workspaceId);
      if (!record) return null;
      return { workspaceId: record.workspaceId, indexing: record.indexing };
    },
    async setIndexing(workspaceId: string, next: IndexingState | null) {
      const record = await registry.get(workspaceId);
      if (!record) {
        throw new Error(`Cannot set indexing on unknown workspace: ${workspaceId}`);
      }
      const updated: PersistedWorkspaceRecord = {
        ...record,
        indexing: next ?? undefined,
        updatedAt: new Date().toISOString(),
      };
      await registry.upsert(updated);
    },
  };
}

async function defaultDirExists(cwd: string): Promise<boolean> {
  try {
    const stat = await fs.stat(cwd);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
