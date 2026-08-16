import type { WorkspaceRuntimeCatalogEntry } from "@getpaseo/protocol/messages";

export type WorkspaceRuntimeCatalogState =
  | { status: "legacy" }
  | { status: "loading" }
  | { status: "ready"; runtimes: readonly WorkspaceRuntimeCatalogEntry[] }
  | { status: "error"; error: string };

export type WorkspaceProviderProbeState =
  | { status: "legacy" }
  | { status: "loading" }
  | { status: "ready"; workspaceId: string }
  | { status: "error"; error: string };

export type WorkspaceProviderSnapshotTarget =
  | { kind: "legacy-cwd" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "unavailable" };

export function resolveWorkspaceProviderProbeTarget(input: {
  supportsWorkspaceRuntimes: boolean;
  probe: WorkspaceProviderProbeState;
}): WorkspaceProviderSnapshotTarget {
  if (!input.supportsWorkspaceRuntimes) {
    // COMPAT(newWorkspaceCwdProbe): added in v0.3.2, remove after 2027-02-12.
    return { kind: "legacy-cwd" };
  }
  if (input.probe.status !== "ready") return { kind: "unavailable" };
  return { kind: "workspace", workspaceId: input.probe.workspaceId };
}

export function resolveWorkspaceProviderSnapshotScope(
  target: WorkspaceProviderSnapshotTarget,
  projectCwd: string | null,
): { enabled: boolean; cwd: string | null; workspaceId: string | null } {
  if (target.kind === "legacy-cwd") {
    return { enabled: true, cwd: projectCwd, workspaceId: null };
  }
  if (target.kind === "workspace") {
    return { enabled: true, cwd: null, workspaceId: target.workspaceId };
  }
  return { enabled: false, cwd: null, workspaceId: null };
}

export type WorkspaceRuntimeVocabulary = "isolation" | "runtime";

export interface WorkspaceRuntimeSelection {
  runtimeId: string;
  availableRuntimes: readonly WorkspaceRuntimeCatalogEntry[];
  canCreateWorkspace: boolean;
  catalogError: string | null;
  showRuntimeControl: boolean;
  showRefPicker: boolean;
  vocabulary: WorkspaceRuntimeVocabulary;
}

const LOCAL_RUNTIME: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "local",
  builtin: true,
  requiresGitProject: false,
};

const WORKTREE_RUNTIME: WorkspaceRuntimeCatalogEntry = {
  runtimeId: "worktree",
  builtin: true,
  requiresGitProject: true,
};

function legacyRuntimeCatalog(canCreateWorktree: boolean): readonly WorkspaceRuntimeCatalogEntry[] {
  if (canCreateWorktree) return [LOCAL_RUNTIME, WORKTREE_RUNTIME];
  return [LOCAL_RUNTIME];
}

export function runtimeLabelKey(
  runtimeId: string,
  vocabulary: WorkspaceRuntimeVocabulary,
): string | null {
  if (vocabulary === "isolation") {
    if (runtimeId === "local") return "newWorkspace.isolation.local";
    if (runtimeId === "worktree") return "newWorkspace.isolation.worktree";
    return null;
  }
  if (runtimeId === "local") return "newWorkspace.runtime.local";
  if (runtimeId === "worktree") return "newWorkspace.runtime.worktree";
  return null;
}

export function runtimeLabel(
  runtime: Pick<WorkspaceRuntimeCatalogEntry, "runtimeId" | "label">,
  vocabulary: WorkspaceRuntimeVocabulary,
  translate: (key: string) => string,
): string {
  const key = runtimeLabelKey(runtime.runtimeId, vocabulary);
  return key ? translate(key) : (runtime.label ?? runtime.runtimeId);
}

export function resolveWorkspaceRuntimeSelection(input: {
  catalog: WorkspaceRuntimeCatalogState;
  selectedRuntimeId: string;
  supportsMultiplicity: boolean;
  worktreeSupport: "supported" | "unsupported" | "unknown";
}): WorkspaceRuntimeSelection {
  if (input.catalog.status === "loading" || input.catalog.status === "error") {
    return {
      runtimeId: input.selectedRuntimeId,
      availableRuntimes: [],
      canCreateWorkspace: false,
      catalogError: input.catalog.status === "error" ? input.catalog.error : null,
      showRuntimeControl: true,
      showRefPicker: input.selectedRuntimeId === "worktree",
      vocabulary: "runtime",
    };
  }

  const canCreateWorktree = input.supportsMultiplicity && input.worktreeSupport !== "unsupported";
  const catalog =
    input.catalog.status === "legacy"
      ? legacyRuntimeCatalog(canCreateWorktree)
      : input.catalog.runtimes;
  const availableRuntimes = catalog.filter(
    (runtime) => !runtime.requiresGitProject || input.worktreeSupport !== "unsupported",
  );
  const selectedRuntime = availableRuntimes.find(
    (runtime) => runtime.runtimeId === input.selectedRuntimeId,
  );
  const runtimeId =
    selectedRuntime?.runtimeId ?? availableRuntimes[0]?.runtimeId ?? input.selectedRuntimeId;
  const vocabulary = input.catalog.status === "legacy" ? "isolation" : "runtime";

  return {
    runtimeId,
    availableRuntimes,
    canCreateWorkspace: availableRuntimes.some((runtime) => runtime.runtimeId === runtimeId),
    catalogError: null,
    showRuntimeControl: vocabulary === "runtime" || canCreateWorktree,
    showRefPicker: !input.supportsMultiplicity || runtimeId === "worktree",
    vocabulary,
  };
}
