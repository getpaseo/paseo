import { basename, resolve } from "node:path";

import type { Logger } from "pino";

import { areEquivalentPaths } from "../../utils/path.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";

// COMPAT(splitRemoteProjectClones): added in v0.2.4 on 2026-07-28; remove after
// 2027-01-28, once every supported install has repaired remote-grouped clones.

interface ProjectRootCohort {
  rootPath: string;
  workspaces: PersistedWorkspaceRecord[];
}

function deriveWorkspaceProjectRoot(workspace: PersistedWorkspaceRecord): string {
  if (workspace.kind === "worktree" && workspace.mainRepoRoot?.trim()) {
    return resolve(workspace.mainRepoRoot);
  }
  return resolve(workspace.cwd);
}

function groupWorkspacesByProjectRoot(workspaces: PersistedWorkspaceRecord[]): ProjectRootCohort[] {
  const cohorts: ProjectRootCohort[] = [];
  for (const workspace of workspaces) {
    const rootPath = deriveWorkspaceProjectRoot(workspace);
    const existing = cohorts.find((cohort) => areEquivalentPaths(cohort.rootPath, rootPath));
    if (existing) {
      existing.workspaces.push(workspace);
    } else {
      cohorts.push({ rootPath, workspaces: [workspace] });
    }
  }
  return cohorts;
}

function earliestCreatedAt(workspaces: PersistedWorkspaceRecord[]): string {
  return workspaces.reduce(
    (earliest, workspace) => (workspace.createdAt < earliest ? workspace.createdAt : earliest),
    workspaces[0]!.createdAt,
  );
}

function isActiveRemoteProject(project: PersistedProjectRecord): boolean {
  return !project.archivedAt && project.projectId.startsWith("remote:");
}

export async function splitRemoteGroupedProjectClones(options: {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<{ projectsCreated: number; projectsRenamed: number; workspacesReassigned: number }> {
  const projects = await options.projectRegistry.list();
  const workspaces = await options.workspaceRegistry.list();
  let projectsCreated = 0;
  let projectsRenamed = 0;
  let workspacesReassigned = 0;

  for (const project of projects.filter(isActiveRemoteProject)) {
    const projectWorkspaces = workspaces.filter(
      (workspace) => workspace.projectId === project.projectId,
    );
    const cohorts = groupWorkspacesByProjectRoot(projectWorkspaces);
    if (cohorts.length <= 1) {
      continue;
    }

    const retainedCohort = cohorts.find((cohort) =>
      areEquivalentPaths(cohort.rootPath, project.rootPath),
    );
    if (!retainedCohort) {
      options.logger.warn(
        {
          projectId: project.projectId,
          projectRootPath: project.rootPath,
          observedRoots: cohorts.map((cohort) => cohort.rootPath),
        },
        "Skipped remote-grouped clone repair because no workspace matches the project root",
      );
      continue;
    }

    const retainedDisplayName = basename(project.rootPath) || project.rootPath;
    if (project.displayName !== retainedDisplayName) {
      const renamedProject = { ...project, displayName: retainedDisplayName };
      await options.projectRegistry.upsert(renamedProject);
      projects.splice(projects.indexOf(project), 1, renamedProject);
      projectsRenamed += 1;
    }

    for (const cohort of cohorts) {
      if (cohort === retainedCohort) {
        continue;
      }

      const hadExistingProject = projects.some(
        (candidate) =>
          !candidate.archivedAt && areEquivalentPaths(candidate.rootPath, cohort.rootPath),
      );
      const targetProject = await options.projectRegistry.getOrCreateActiveByRoot({
        rootPath: cohort.rootPath,
        kind: project.kind,
        displayName: basename(cohort.rootPath) || cohort.rootPath,
        timestamp: earliestCreatedAt(cohort.workspaces),
      });
      if (!hadExistingProject) {
        projects.push(targetProject);
        projectsCreated += 1;
      }

      for (const workspace of cohort.workspaces) {
        const updated = await options.workspaceRegistry.update(workspace.workspaceId, (record) => ({
          ...record,
          projectId: targetProject.projectId,
        }));
        if (updated) {
          workspacesReassigned += 1;
        }
      }
    }
  }

  if (projectsCreated > 0 || projectsRenamed > 0 || workspacesReassigned > 0) {
    options.logger.info(
      { projectsCreated, projectsRenamed, workspacesReassigned },
      "Split remote-grouped independent clones into directory projects",
    );
  }
  return { projectsCreated, projectsRenamed, workspacesReassigned };
}
