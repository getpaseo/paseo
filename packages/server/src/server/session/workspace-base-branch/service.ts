import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getCheckoutSnapshotFacts, setCheckoutBaseBranch } from "../../../utils/checkout-git.js";
import {
  getPaseoWorktreeMetadataPath,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadataFile,
} from "../../../utils/worktree-metadata.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";

interface Dependencies {
  workspaceRegistry: WorkspaceRegistry;
  workspaceGitService: WorkspaceGitService;
}

export function createWorkspaceBaseBranchService(deps: Dependencies) {
  const queues = new Map<string, Promise<void>>();

  async function setBaseBranch(input: { workspaceId: string; baseRef: string }): Promise<string> {
    const workspace = await deps.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error("Workspace is unavailable");
    const facts = await getCheckoutSnapshotFacts(workspace.cwd);
    if (!facts.isGit) throw new Error("Workspace is not a Git checkout");
    const root = resolve(facts.worktreeRoot);
    const previous = queues.get(root);
    let release!: () => void;
    const queued = new Promise<void>((done) => {
      release = done;
    });
    queues.set(root, queued);
    await previous;

    try {
      const current = await deps.workspaceRegistry.get(input.workspaceId);
      if (!current || current.archivedAt) throw new Error("Workspace is unavailable");
      const records = await deps.workspaceRegistry.list();
      const matching = records.filter(
        (record) =>
          record.workspaceId === input.workspaceId ||
          resolve(record.worktreeRoot ?? record.cwd) === root,
      );
      await deps.workspaceGitService.getSnapshot(root);
      const metadata = readPaseoWorktreeMetadata(root);
      const baseRef = await setCheckoutBaseBranch({ cwd: root, baseRef: input.baseRef });
      const updatedAt = new Date().toISOString();
      try {
        for (const record of matching) {
          await deps.workspaceRegistry.update(record.workspaceId, (latest) => ({
            ...latest,
            baseBranch: baseRef,
            updatedAt,
          }));
        }
      } catch (error) {
        if (metadata) writePaseoWorktreeMetadataFile(root, metadata);
        else unlinkSync(getPaseoWorktreeMetadataPath(root));
        for (const record of matching) {
          await deps.workspaceRegistry.update(record.workspaceId, (latest) => ({
            ...latest,
            baseBranch: record.baseBranch,
            updatedAt: record.updatedAt,
          }));
        }
        throw error;
      }
      for (const cwd of new Set(matching.map((record) => record.cwd))) {
        await deps.workspaceGitService.getSnapshot(cwd, {
          force: true,
          includeForge: false,
          reason: "base-branch-change",
        });
      }
      return baseRef;
    } finally {
      release();
      if (queues.get(root) === queued) queues.delete(root);
    }
  }

  return { setBaseBranch };
}

export type WorkspaceBaseBranchService = ReturnType<typeof createWorkspaceBaseBranchService>;
