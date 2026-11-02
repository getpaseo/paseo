import { resolve } from "node:path";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

export interface WorkspaceRuntimeStore {
  get(cwd: string): WorkspaceGitRuntimeSnapshot | null;
  set(snapshot: WorkspaceGitRuntimeSnapshot): void;
  remove(cwd: string): void;
}

export function createWorkspaceRuntimeStore(): WorkspaceRuntimeStore {
  const snapshots = new Map<string, WorkspaceGitRuntimeSnapshot>();
  return {
    get(cwd) {
      return snapshots.get(resolve(cwd)) ?? null;
    },
    set(snapshot) {
      snapshots.set(resolve(snapshot.cwd), snapshot);
    },
    remove(cwd) {
      snapshots.delete(resolve(cwd));
    },
  };
}
