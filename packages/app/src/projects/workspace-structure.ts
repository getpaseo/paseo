import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  worktreeSupport: "supported" | "unsupported" | "unknown";
  customIconRevision?: string | null;
}

export interface WorkspaceStructureProject {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  projectKind: WorkspaceDescriptor["projectKind"] | "unknown";
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaceKeys: string[];
}

export interface WorkspaceStructure {
  projects: WorkspaceStructureProject[];
}

interface WorkspaceStructureSession {
  serverId: string;
  projects: Iterable<ProjectDescriptor>;
  workspaces: Iterable<WorkspaceDescriptor>;
}

interface ProjectDraft {
  viewKey: string;
  projectKey: string | null;
  projectName: string;
  hasCustomName: boolean;
  projectKind: WorkspaceDescriptor["projectKind"];
  iconWorkingDir: string;
  hosts: Map<string, WorkspaceStructureHostPlacement>;
  workspaces: Array<{ workspaceId: string; workspaceName: string; workspaceKey: string }>;
}

/** The single app boundary that turns host-local projects into grouped display projects. */
export function buildWorkspaceStructureProjects(input: {
  sessions: WorkspaceStructureSession[];
}): WorkspaceStructureProject[] {
  const byProject = new Map<string, ProjectDraft>();
  const projectEntries: Array<{ serverId: string; project: ProjectDescriptor }> = [];
  const keyCountsByServer = new Map<string, Map<string, number>>();
  const viewKeyByServerProjectId = new Map<string, Map<string, string>>();

  for (const session of input.sessions) {
    for (const project of session.projects) {
      projectEntries.push({ serverId: session.serverId, project });
    }
  }

  const legacyMergeKeys = buildLegacyNestedProjectMergeKeys(projectEntries);
  const sharedKeyByPlacement = new Map<string, string | null>();
  for (const { serverId, project } of projectEntries) {
    const placementKey = createProjectViewKey({
      kind: "placement",
      serverId,
      projectId: project.projectId,
    });
    const sharedKey =
      legacyMergeKeys.get(placementKey) ??
      project.projectKey ??
      canonicalLegacyRemoteProjectKey(project.projectId);
    sharedKeyByPlacement.set(placementKey, sharedKey);
    if (!sharedKey) continue;
    const counts = getOrCreate(keyCountsByServer, serverId, () => new Map());
    counts.set(sharedKey, (counts.get(sharedKey) ?? 0) + 1);
  }

  const allocatedViewKeys = new Set(
    Array.from(sharedKeyByPlacement.values()).filter((key): key is string => key !== null),
  );

  for (const { serverId, project } of projectEntries) {
    const placementKey = createProjectViewKey({
      kind: "placement",
      serverId,
      projectId: project.projectId,
    });
    const viewKey = addProjectToView({
      byProject,
      keyCountsByServer,
      allocatedViewKeys,
      serverId,
      project,
      sharedKey: sharedKeyByPlacement.get(placementKey) ?? null,
      forceSharedKey: legacyMergeKeys.has(placementKey),
    });
    getOrCreate(viewKeyByServerProjectId, serverId, () => new Map()).set(
      project.projectId,
      viewKey,
    );
  }

  for (const session of input.sessions) {
    for (const workspace of session.workspaces) {
      const viewKey = viewKeyByServerProjectId.get(session.serverId)?.get(workspace.projectId);
      if (!viewKey) continue;
      byProject.get(viewKey)?.workspaces.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKey: `${session.serverId}:${workspace.id}`,
      });
    }
  }

  return Array.from(byProject.values())
    .map((draft) => ({
      viewKey: draft.viewKey,
      projectKey: draft.projectKey,
      projectName: draft.projectName,
      projectKind: draft.projectKind,
      iconWorkingDir: draft.iconWorkingDir,
      hosts: Array.from(draft.hosts.values()).sort(compareHostPlacements),
      workspaceKeys: draft.workspaces
        .sort(compareWorkspaceStructureItems)
        .map((workspace) => workspace.workspaceKey),
    }))
    .sort(
      (left, right) =>
        left.projectName.localeCompare(right.projectName, undefined, {
          numeric: true,
          sensitivity: "base",
        }) || left.viewKey.localeCompare(right.viewKey),
    );
}

export function createProjectViewKey(
  identity:
    | { kind: "equivalence"; projectKey: string }
    | { kind: "placement"; serverId: string; projectId: string },
): string {
  return identity.kind === "equivalence"
    ? identity.projectKey
    : JSON.stringify([identity.serverId, identity.projectId]);
}

function allocatePlacementViewKey(
  allocatedViewKeys: Set<string>,
  serverId: string,
  projectId: string,
): string {
  const legacyKey = createProjectViewKey({ kind: "placement", serverId, projectId });
  if (!allocatedViewKeys.has(legacyKey)) {
    allocatedViewKeys.add(legacyKey);
    return legacyKey;
  }

  for (let suffix = 0; ; suffix += 1) {
    const collisionKey = JSON.stringify(["placement", serverId, projectId, suffix]);
    if (allocatedViewKeys.has(collisionKey)) continue;
    allocatedViewKeys.add(collisionKey);
    return collisionKey;
  }
}

function addProjectToView(input: {
  byProject: Map<string, ProjectDraft>;
  keyCountsByServer: Map<string, Map<string, number>>;
  allocatedViewKeys: Set<string>;
  serverId: string;
  project: ProjectDescriptor;
  sharedKey: string | null;
  forceSharedKey: boolean;
}): string {
  const { byProject, keyCountsByServer, serverId, project } = input;
  const sharedKey = input.sharedKey;
  const canUseSharedKey =
    sharedKey !== null &&
    (input.forceSharedKey || keyCountsByServer.get(serverId)?.get(sharedKey) === 1);
  const viewKey = canUseSharedKey
    ? createProjectViewKey({ kind: "equivalence", projectKey: sharedKey })
    : allocatePlacementViewKey(input.allocatedViewKeys, serverId, project.projectId);
  const placement: WorkspaceStructureHostPlacement = {
    serverId,
    projectId: project.projectId,
    iconWorkingDir: project.projectRootPath,
    worktreeSupport: project.projectKind === "git" ? "supported" : "unsupported",
    customIconRevision: project.projectCustomIconRevision,
  };
  const draft = byProject.get(viewKey);
  if (!draft) {
    byProject.set(viewKey, {
      viewKey,
      projectKey: sharedKey,
      projectName:
        project.projectCustomName ??
        project.projectDisplayName ??
        projectDisplayNameFromProjectId(project.projectId),
      hasCustomName: Boolean(project.projectCustomName),
      projectKind: project.projectKind,
      iconWorkingDir: project.projectRootPath,
      hosts: new Map([[hostPlacementKey(placement), placement]]),
      workspaces: [],
    });
  } else {
    if (project.projectCustomName && !draft.hasCustomName) {
      draft.projectName = project.projectCustomName;
      draft.hasCustomName = true;
    }
    if (project.projectKind === "git" && draft.projectKind !== "git") {
      draft.projectKind = "git";
    }
    draft.hosts.set(hostPlacementKey(placement), placement);
  }
  return viewKey;
}

// COMPAT(legacyNestedRemoteProjectGrouping): added in v0.3.0, remove after 2027-02-09 once legacy path/remote project records are retired.
function buildLegacyNestedProjectMergeKeys(
  entries: Array<{ serverId: string; project: ProjectDescriptor }>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const local of entries) {
    if (local.project.projectKind !== "non_git") continue;
    const matches = entries.filter((candidate) => {
      if (candidate.serverId !== local.serverId || candidate === local) return false;
      const remoteKey =
        candidate.project.projectKey ??
        canonicalLegacyRemoteProjectKey(candidate.project.projectId);
      if (!remoteKey?.startsWith("remote:")) return false;
      if (!isPathInside(local.project.projectRootPath, candidate.project.projectRootPath)) {
        return false;
      }
      return projectNameTail(local.project) === projectNameTail(candidate.project);
    });
    if (matches.length !== 1) continue;
    const remote = matches[0]!;
    const remoteKey =
      remote.project.projectKey ?? canonicalLegacyRemoteProjectKey(remote.project.projectId);
    if (!remoteKey) continue;
    result.set(
      createProjectViewKey({
        kind: "placement",
        serverId: local.serverId,
        projectId: local.project.projectId,
      }),
      remoteKey,
    );
    result.set(
      createProjectViewKey({
        kind: "placement",
        serverId: remote.serverId,
        projectId: remote.project.projectId,
      }),
      remoteKey,
    );
  }
  return result;
}

function canonicalLegacyRemoteProjectKey(projectId: string): string | null {
  if (!projectId.startsWith("remote:")) return null;
  const separator = projectId.indexOf("/", "remote:".length);
  if (separator < 0) return null;
  const host = projectId.slice("remote:".length, separator).toLowerCase();
  const remotePath = projectId
    .slice(separator + 1)
    .replace(/\.git$/iu, "")
    .replace(/^\/+|\/+$/gu, "");
  if (!host || !remotePath) return null;
  const canonicalPath = host === "github.com" ? remotePath.toLowerCase() : remotePath;
  return `remote:${host}/${canonicalPath}`;
}

function projectNameTail(project: ProjectDescriptor): string {
  const displayName =
    project.projectDisplayName ?? projectDisplayNameFromProjectId(project.projectId);
  return displayName.match(/[^\\/]+$/u)?.[0]?.toLocaleLowerCase() ?? "";
}

function normalizePathForContainment(projectPath: string): string {
  const normalized = projectPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = normalizePathForContainment(parentPath);
  const child = normalizePathForContainment(childPath);
  return child === parent || child.startsWith(`${parent}/`);
}

function hostPlacementKey(placement: WorkspaceStructureHostPlacement): string {
  return JSON.stringify([placement.serverId, placement.projectId]);
}

function compareHostPlacements(
  left: WorkspaceStructureHostPlacement,
  right: WorkspaceStructureHostPlacement,
): number {
  const supportOrder = { supported: 0, unknown: 1, unsupported: 2 } as const;
  return (
    supportOrder[left.worktreeSupport] - supportOrder[right.worktreeSupport] ||
    left.serverId.localeCompare(right.serverId) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const value = create();
  map.set(key, value);
  return value;
}

function compareWorkspaceStructureItems(
  left: { workspaceId: string; workspaceName: string },
  right: { workspaceId: string; workspaceName: string },
): number {
  return (
    left.workspaceName.localeCompare(right.workspaceName, undefined, {
      numeric: true,
      sensitivity: "base",
    }) || left.workspaceId.localeCompare(right.workspaceId, undefined, { sensitivity: "base" })
  );
}
