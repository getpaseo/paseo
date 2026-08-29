import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import {
  buildProjectLinkGroupingOverrides,
  buildProjectLinkPlacements,
  localProjectLinkViewKey,
  projectLinkPlacementKey,
  type LocalProjectLink,
  type ProjectLinkGroupingOverride,
} from "./local-project-links";

export interface WorkspaceStructureHostPlacement {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  worktreeSupport: "supported" | "unsupported" | "unknown";
  customIconRevision?: string | null;
  iconRevision?: string;
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
  localProjectLinks?: Iterable<LocalProjectLink>;
}): WorkspaceStructureProject[] {
  // Selectors may pass one-shot Map iterators. Materialize once because local-link verification
  // reads the same project/workspace facts that the structural projection consumes below.
  const sessions = input.sessions.map((session) => ({
    ...session,
    projects: Array.from(session.projects),
    workspaces: Array.from(session.workspaces),
  }));
  const localProjectLinks = Array.from(input.localProjectLinks ?? []);
  const byProject = new Map<string, ProjectDraft>();
  const projectEntries: Array<{ serverId: string; project: ProjectDescriptor }> = [];
  const keyCountsByServer = new Map<string, Map<string, number>>();
  const viewKeyByServerProjectId = new Map<string, Map<string, string>>();

  for (const session of sessions) {
    for (const project of session.projects) {
      projectEntries.push({ serverId: session.serverId, project });
      const sharedKey = project.projectKey ?? null;
      if (sharedKey) {
        const counts = getOrCreate(keyCountsByServer, session.serverId, () => new Map());
        counts.set(sharedKey, (counts.get(sharedKey) ?? 0) + 1);
      }
    }
  }

  const allocatedViewKeys = new Set(
    projectEntries.flatMap(({ project }) => (project.projectKey ? [project.projectKey] : [])),
  );
  const projectLinkOverrides = buildProjectLinkGroupingOverrides({
    placements: buildProjectLinkPlacements({
      hosts: sessions.map((session) => ({
        serverId: session.serverId,
        serverName: "",
        projects: session.projects,
        workspaces: session.workspaces,
      })),
    }),
    links: localProjectLinks,
  });
  const localLinkViewKeys = allocateLocalLinkViewKeys({
    overrides: projectLinkOverrides,
    allocatedViewKeys,
  });

  for (const { serverId, project } of projectEntries) {
    const projectLinkOverride = projectLinkOverrides.get(
      projectLinkPlacementKey({ serverId, projectId: project.projectId }),
    );
    const viewKey = addProjectToView({
      byProject,
      keyCountsByServer,
      allocatedViewKeys,
      serverId,
      project,
      projectLinkOverride,
      localLinkViewKeys,
    });
    getOrCreate(viewKeyByServerProjectId, serverId, () => new Map()).set(
      project.projectId,
      viewKey,
    );
  }

  for (const session of sessions) {
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
      hosts: Array.from(draft.hosts.values()),
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
  projectLinkOverride: ProjectLinkGroupingOverride | undefined;
  localLinkViewKeys: ReadonlyMap<string, string>;
}): string {
  const { byProject, keyCountsByServer, serverId, project, projectLinkOverride } = input;
  const sharedKey = project.projectKey ?? null;
  const canUseSharedKey =
    projectLinkOverride === undefined &&
    sharedKey !== null &&
    keyCountsByServer.get(serverId)?.get(sharedKey) === 1;
  let viewKey: string;
  if (projectLinkOverride?.kind === "linked") {
    viewKey =
      input.localLinkViewKeys.get(projectLinkOverride.linkId) ??
      allocatePlacementViewKey(input.allocatedViewKeys, serverId, project.projectId);
  } else if (canUseSharedKey) {
    viewKey = createProjectViewKey({ kind: "equivalence", projectKey: sharedKey });
  } else {
    viewKey = allocatePlacementViewKey(input.allocatedViewKeys, serverId, project.projectId);
  }
  const effectiveProjectKey = projectLinkOverride?.kind === "linked" ? null : sharedKey;
  const placement: WorkspaceStructureHostPlacement = {
    serverId,
    projectId: project.projectId,
    iconWorkingDir: project.projectRootPath,
    worktreeSupport: project.projectKind === "git" ? "supported" : "unsupported",
    customIconRevision: project.projectCustomIconRevision,
    iconRevision: project.projectIconRevision,
  };
  const draft = byProject.get(viewKey);
  if (!draft) {
    byProject.set(viewKey, {
      viewKey,
      projectKey: effectiveProjectKey,
      projectName:
        project.projectCustomName ??
        project.projectDisplayName ??
        projectDisplayNameFromProjectId(project.projectId),
      hasCustomName: Boolean(project.projectCustomName),
      projectKind: project.projectKind,
      iconWorkingDir: project.projectRootPath,
      hosts: new Map([[serverId, placement]]),
      workspaces: [],
    });
  } else {
    if (project.projectCustomName && !draft.hasCustomName) {
      draft.projectName = project.projectCustomName;
      draft.hasCustomName = true;
    }
    draft.hosts.set(serverId, placement);
  }
  return viewKey;
}

function allocateLocalLinkViewKeys(input: {
  overrides: ReadonlyMap<string, ProjectLinkGroupingOverride>;
  allocatedViewKeys: Set<string>;
}): Map<string, string> {
  const linkIds = Array.from(
    new Set(
      Array.from(input.overrides.values()).flatMap((override) =>
        override.kind === "linked" ? [override.linkId] : [],
      ),
    ),
  ).sort();
  const viewKeys = new Map<string, string>();
  for (const linkId of linkIds) {
    const baseViewKey = localProjectLinkViewKey(linkId);
    let viewKey = baseViewKey;
    for (let suffix = 0; input.allocatedViewKeys.has(viewKey); suffix += 1) {
      viewKey = JSON.stringify(["local-project-link", linkId, suffix]);
    }
    input.allocatedViewKeys.add(viewKey);
    viewKeys.set(linkId, viewKey);
  }
  return viewKeys;
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
