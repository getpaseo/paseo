import { resolve } from "node:path";
import type { WorkspaceGitService, WorkspaceGitWorkspace } from "./workspace-git-service.js";
import {
  type PersistedWorkspaceRecord,
  resolveSelectedWorkspaceRuntimeId,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

export type WorkspaceGitAddress =
  | { readonly kind: "selected"; readonly workspaceId: string; readonly cwd: string }
  | { readonly kind: "legacy"; readonly cwd: string };

export interface WorkspaceGitDirectory {
  resolve(address: WorkspaceGitAddress): Promise<WorkspaceGitWorkspace>;
  bindRecord(
    record: Pick<PersistedWorkspaceRecord, "workspaceId" | "cwd" | "runtime">,
  ): WorkspaceGitWorkspace;
  getBound(workspaceId: string, cwd: string): WorkspaceGitWorkspace;
  getObservationBinding(
    workspaceId: string,
    cwd: string,
  ): {
    address: WorkspaceGitAddress;
    workspaceGit: WorkspaceGitWorkspace;
  };
}

/** Commits request compatibility once, before ordinary Git callers receive a capability. */
export function createWorkspaceGitDirectory(options: {
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list">;
  workspaceGitService: Pick<WorkspaceGitService, "bindLegacy" | "bindWorkspace">;
}): WorkspaceGitDirectory {
  const { workspaceRegistry, workspaceGitService } = options;
  const boundRecords = new Map<
    string,
    { cwd: string; selected: boolean; workspaceGit: WorkspaceGitWorkspace }
  >();

  function bindRecord(
    record: Pick<PersistedWorkspaceRecord, "workspaceId" | "cwd" | "runtime">,
  ): WorkspaceGitWorkspace {
    const selected = record.runtime?.runtimeId !== undefined;
    const cwd = selected ? record.cwd.trim() : resolve(record.cwd);
    const existing = boundRecords.get(record.workspaceId);
    if (existing) {
      if (existing.cwd !== cwd)
        throw new Error(`Workspace Git binding changed cwd: ${record.workspaceId}`);
      return existing.workspaceGit;
    }
    const workspaceGit = selected
      ? workspaceGitService.bindWorkspace({
          workspaceId: record.workspaceId,
          cwd,
        })
      : workspaceGitService.bindLegacy(cwd);
    boundRecords.set(record.workspaceId, { cwd, selected, workspaceGit });
    return workspaceGit;
  }

  return {
    bindRecord,
    getBound(workspaceId, cwd) {
      const bound = boundRecords.get(workspaceId);
      const addressedCwd = bound?.selected ? cwd.trim() : resolve(cwd);
      if (!bound || bound.cwd !== addressedCwd) {
        throw new Error(`Workspace Git is not bound: ${workspaceId}`);
      }
      return bound.workspaceGit;
    },
    getObservationBinding(workspaceId, cwd) {
      const bound = boundRecords.get(workspaceId);
      const addressedCwd = bound?.selected ? cwd.trim() : resolve(cwd);
      if (!bound || bound.cwd !== addressedCwd) {
        throw new Error(`Workspace Git is not bound: ${workspaceId}`);
      }
      return {
        address: bound.selected
          ? { kind: "selected", workspaceId, cwd: addressedCwd }
          : { kind: "legacy", cwd: addressedCwd },
        workspaceGit: bound.workspaceGit,
      };
    },
    async resolve(address) {
      if (address.kind === "selected") {
        const workspaceId = address.workspaceId.trim();
        if (workspaceId.length === 0) {
          throw new Error("workspaceId is required for selected workspace Git");
        }
        const selectedCwd = address.cwd.trim();
        if (selectedCwd.length === 0) {
          throw new Error("cwd is required for selected workspace Git");
        }
        const record = await workspaceRegistry.get(workspaceId);
        if (!record) throw new Error(`Workspace not found: ${workspaceId}`);
        if (record.cwd.trim() !== selectedCwd) {
          throw new Error(`Workspace cwd does not match ${workspaceId}`);
        }
        return bindRecord(record);
      }

      const cwd = resolve(address.cwd);
      const runtimeOnlyAtCwd = (await workspaceRegistry.list()).some(
        (record) =>
          resolveSelectedWorkspaceRuntimeId(record) !== null &&
          resolve(record.cwd) === cwd &&
          record.hostVisiblePath === null,
      );
      if (runtimeOnlyAtCwd) {
        throw new Error("workspaceId is required for a selected workspace Git operation");
      }
      return workspaceGitService.bindLegacy(cwd);
    },
  };
}
