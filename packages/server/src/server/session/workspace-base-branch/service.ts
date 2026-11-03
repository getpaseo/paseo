import { resolve } from "node:path";
import { getCheckoutSnapshotFacts, setCheckoutBaseBranch } from "../../../utils/checkout-git.js";
import {
  readPaseoWorktreeMetadata,
  setPaseoWorktreeBaseRef,
} from "../../../utils/worktree-metadata.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";

interface Dependencies {
  paseoHome: string;
  worktreesRoot?: string;
  workspaceRegistry: WorkspaceRegistry;
  workspaceGitService: WorkspaceGitService;
}

export function createWorkspaceBaseBranchService(deps: Dependencies) {
  const queues = new Map<string, Promise<void>>();

  async function withCheckoutLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    root = resolve(root);
    const previous = queues.get(root);
    let release!: () => void;
    const queued = new Promise<void>((done) => {
      release = done;
    });
    queues.set(root, queued);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (queues.get(root) === queued) queues.delete(root);
    }
  }

  async function setBaseBranch(input: { workspaceId: string; baseRef: string }): Promise<string> {
    const workspace = await deps.workspaceRegistry.get(input.workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error("Workspace is unavailable");
    const facts = await getCheckoutSnapshotFacts(workspace.cwd, {
      paseoHome: deps.paseoHome,
      worktreesRoot: deps.worktreesRoot,
    });
    if (!facts.isGit) throw new Error("Workspace is not a Git checkout");
    if (!facts.paseoWorktree.isPaseoOwnedWorktree)
      throw new Error("Workspace is not a Paseo worktree");
    const root = resolve(facts.worktreeRoot);
    return withCheckoutLock(root, async () => {
      const current = await deps.workspaceRegistry.get(input.workspaceId);
      if (!current || current.archivedAt) throw new Error("Workspace is unavailable");
      const records = await deps.workspaceRegistry.list();
      const matching = records.filter(
        (record) =>
          record.workspaceId === input.workspaceId ||
          resolve(record.worktreeRoot ?? record.cwd) === root,
      );
      await deps.workspaceGitService.getSnapshot(root);
      const metadata = await readPaseoWorktreeMetadata(root);
      const baseRef = await setCheckoutBaseBranch({
        cwd: root,
        baseRef: input.baseRef,
        context: { paseoHome: deps.paseoHome, worktreesRoot: deps.worktreesRoot },
      });
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
        if (metadata)
          await setPaseoWorktreeBaseRef({
            worktreeRoot: root,
            baseRef: metadata.baseRef ?? metadata.baseRefName,
          });
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
          afterInFlight: true,
          includeForge: false,
          reason: "base-branch-change",
        });
      }
      return baseRef;
    });
  }

  return { setBaseBranch, withCheckoutLock };
}

export type WorkspaceBaseBranchService = ReturnType<typeof createWorkspaceBaseBranchService>;
