import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as base } from "./fixtures";
import {
  beginWorkspaceFromProject,
  createWorkspaceWithoutAgent,
  expectProjectContainsWorkspaces,
  expectProjectSettingsName,
  expectProjectWorkspaceCountForHost,
  expectSeparateProjects,
  openGroupedProjectSettings,
  openProjectsForSettingsHost,
  openProjectDirectory,
  openProjectDirectoryWithHosts,
  renameProject,
  selectWorkspaceHost,
} from "./helpers/project-grouping";
import { type IsolatedHostDaemon, startIsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import { connectSeedClient, type SeedDaemonClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_LABEL = "Secondary Host";
const LEGACY_PRIMARY_HOST_LABEL = "Legacy Primary Host";
const LEGACY_SECONDARY_HOST_LABEL = "Legacy Secondary Host";
const GROUPED_PROJECT_NAME = "paseo-e2e/grouped-project";
const SHARED_REMOTE_URL = "https://github.com/paseo-e2e/grouped-project.git";
const SUBDIRECTORY = path.join("packages", "app");
const REPO_FILES = [{ path: path.join(SUBDIRECTORY, "package.json"), content: "{}\n" }];

interface HostConnection {
  serverId: string;
  label: string;
  port: number;
}

interface ProjectDirectoryScenario {
  hosts: HostConnection[];
  primaryLabel?: string;
}

interface CreatedProject {
  projectId: string;
}

async function createProject(
  client: SeedDaemonClient,
  input: {
    projectPath: string;
    serverId: string;
    workspaceName: string;
    projectName?: string;
  },
): Promise<CreatedProject> {
  const created = await client.createWorkspace({
    source: { kind: "directory", path: input.projectPath },
    title: input.workspaceName,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create project on ${input.serverId}`);
  }
  if (input.projectName) {
    await client.renameProject(created.workspace.projectId, input.projectName);
  }
  return { projectId: created.workspace.projectId };
}

async function removePersistedProjectKeys(host: IsolatedHostDaemon): Promise<void> {
  const projectsPath = path.join(host.paseoHome, "projects", "projects.json");
  const projects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  for (const project of projects) delete project.projectKey;
  await writeFile(projectsPath, JSON.stringify(projects));
}

const test = base.extend<{
  crossHostProject: ProjectDirectoryScenario;
  reconciledCrossHostProject: ProjectDirectoryScenario;
  rootAndSubdirectoryProjects: ProjectDirectoryScenario;
  crossHostSubdirectoryProject: ProjectDirectoryScenario;
  sameHostClones: ProjectDirectoryScenario;
}>({
  crossHostProject: async ({ page: _page }, provide) => {
    const secondaryHost = await startIsolatedHostDaemon("project-grouping-secondary");
    const primaryRepo = await createTempGitRepo("grouped-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryRepo = await createTempGitRepo("grouped-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryHost.port });
    let primary: CreatedProject | null = null;
    let secondary: CreatedProject | null = null;

    try {
      primary = await createProject(primaryClient, {
        projectPath: primaryRepo.path,
        serverId: getServerId(),
        workspaceName: "Primary workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      secondary = await createProject(secondaryClient, {
        projectPath: secondaryRepo.path,
        serverId: secondaryHost.serverId,
        workspaceName: "Secondary workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      await provide({
        primaryLabel: PRIMARY_HOST_LABEL,
        hosts: [
          {
            serverId: secondaryHost.serverId,
            label: SECONDARY_HOST_LABEL,
            port: secondaryHost.port,
          },
        ],
      });
    } finally {
      if (primary) await primaryClient.removeProject(primary.projectId).catch(() => undefined);
      if (secondary)
        await secondaryClient.removeProject(secondary.projectId).catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await primaryRepo.cleanup().catch(() => undefined);
      await secondaryRepo.cleanup().catch(() => undefined);
      await secondaryHost.close().catch(() => undefined);
    }
  },

  reconciledCrossHostProject: async ({ page: _page }, provide) => {
    const primaryHost = await startIsolatedHostDaemon("project-grouping-legacy-primary");
    const secondaryHost = await startIsolatedHostDaemon("project-grouping-legacy-secondary");
    const primaryRepo = await createTempGitRepo("grouped-legacy-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryRepo = await createTempGitRepo("grouped-legacy-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient({ port: primaryHost.port });
    const secondaryClient = await connectSeedClient({ port: secondaryHost.port });

    try {
      await createProject(primaryClient, {
        projectPath: primaryRepo.path,
        serverId: primaryHost.serverId,
        workspaceName: "Recovered primary workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      await createProject(secondaryClient, {
        projectPath: secondaryRepo.path,
        serverId: secondaryHost.serverId,
        workspaceName: "Recovered secondary workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      await primaryClient.close();
      await secondaryClient.close();
      await removePersistedProjectKeys(primaryHost);
      await removePersistedProjectKeys(secondaryHost);
      await Promise.all([primaryHost.restart(), secondaryHost.restart()]);

      await provide({
        hosts: [
          {
            serverId: primaryHost.serverId,
            label: LEGACY_PRIMARY_HOST_LABEL,
            port: primaryHost.port,
          },
          {
            serverId: secondaryHost.serverId,
            label: LEGACY_SECONDARY_HOST_LABEL,
            port: secondaryHost.port,
          },
        ],
      });
    } finally {
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await primaryHost.close().catch(() => undefined);
      await secondaryHost.close().catch(() => undefined);
      await primaryRepo.cleanup().catch(() => undefined);
      await secondaryRepo.cleanup().catch(() => undefined);
    }
  },

  rootAndSubdirectoryProjects: async ({ page: _page }, provide) => {
    const repo = await createTempGitRepo("grouped-root-subdir-", {
      originUrl: SHARED_REMOTE_URL,
      files: REPO_FILES,
    });
    const client = await connectSeedClient();
    const projects: CreatedProject[] = [];

    try {
      projects.push(
        await createProject(client, {
          projectPath: repo.path,
          serverId: getServerId(),
          workspaceName: "Repository root workspace",
          projectName: "Repository root project",
        }),
      );
      projects.push(
        await createProject(client, {
          projectPath: path.join(repo.path, SUBDIRECTORY),
          serverId: getServerId(),
          workspaceName: "App package workspace",
          projectName: "App package project",
        }),
      );
      await provide({ hosts: [] });
    } finally {
      for (const project of projects) {
        await client.removeProject(project.projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  },

  crossHostSubdirectoryProject: async ({ page: _page }, provide) => {
    const secondaryHost = await startIsolatedHostDaemon("project-grouping-subdir-secondary");
    const primaryRepo = await createTempGitRepo("grouped-subdir-primary-", {
      originUrl: SHARED_REMOTE_URL,
      files: REPO_FILES,
    });
    const secondaryRepo = await createTempGitRepo("grouped-subdir-secondary-", {
      originUrl: SHARED_REMOTE_URL,
      files: REPO_FILES,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryHost.port });
    let primary: CreatedProject | null = null;
    let secondary: CreatedProject | null = null;

    try {
      primary = await createProject(primaryClient, {
        projectPath: path.join(primaryRepo.path, SUBDIRECTORY),
        serverId: getServerId(),
        workspaceName: "Primary app workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      secondary = await createProject(secondaryClient, {
        projectPath: path.join(secondaryRepo.path, SUBDIRECTORY),
        serverId: secondaryHost.serverId,
        workspaceName: "Secondary app workspace",
        projectName: GROUPED_PROJECT_NAME,
      });
      await provide({
        primaryLabel: PRIMARY_HOST_LABEL,
        hosts: [
          {
            serverId: secondaryHost.serverId,
            label: SECONDARY_HOST_LABEL,
            port: secondaryHost.port,
          },
        ],
      });
    } finally {
      if (primary) await primaryClient.removeProject(primary.projectId).catch(() => undefined);
      if (secondary)
        await secondaryClient.removeProject(secondary.projectId).catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await secondaryClient.close().catch(() => undefined);
      await primaryRepo.cleanup().catch(() => undefined);
      await secondaryRepo.cleanup().catch(() => undefined);
      await secondaryHost.close().catch(() => undefined);
    }
  },

  sameHostClones: async ({ page: _page }, provide) => {
    const firstRepo = await createTempGitRepo("grouped-clone-first-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondRepo = await createTempGitRepo("grouped-clone-second-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const client = await connectSeedClient();
    const projects: CreatedProject[] = [];

    try {
      projects.push(
        await createProject(client, {
          projectPath: firstRepo.path,
          serverId: getServerId(),
          workspaceName: "First clone workspace",
          projectName: "First clone",
        }),
      );
      projects.push(
        await createProject(client, {
          projectPath: secondRepo.path,
          serverId: getServerId(),
          workspaceName: "Second clone workspace",
          projectName: "Second clone",
        }),
      );
      await provide({ hosts: [] });
    } finally {
      for (const project of projects) {
        await client.removeProject(project.projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await firstRepo.cleanup().catch(() => undefined);
      await secondRepo.cleanup().catch(() => undefined);
    }
  },
});

async function openScenario(
  page: Parameters<typeof openProjectDirectory>[0],
  scenario: ProjectDirectoryScenario,
): Promise<void> {
  if (scenario.hosts.length === 0) {
    await openProjectDirectory(page);
    return;
  }
  await openProjectDirectoryWithHosts(page, scenario);
}

test.describe("Sidebar project grouping", () => {
  test.describe.configure({ timeout: 120_000 });

  test("groups projects with the same Git remote across hosts", async ({
    page,
    crossHostProject,
  }) => {
    await openScenario(page, crossHostProject);
    await expectProjectContainsWorkspaces(page, {
      projectName: GROUPED_PROJECT_NAME,
      workspaceNames: ["Primary workspace", "Secondary workspace"],
    });
  });

  test("groups persisted projects missing project keys after boot", async ({
    page,
    reconciledCrossHostProject,
  }) => {
    await openScenario(page, reconciledCrossHostProject);
    await expectProjectContainsWorkspaces(page, {
      projectName: GROUPED_PROJECT_NAME,
      workspaceNames: ["Recovered primary workspace", "Recovered secondary workspace"],
    });
  });

  test("keeps a repository root and its subdirectory as separate projects", async ({
    page,
    rootAndSubdirectoryProjects,
  }) => {
    await openScenario(page, rootAndSubdirectoryProjects);
    await expectSeparateProjects(page, [
      { projectName: "Repository root project", workspaceName: "Repository root workspace" },
      { projectName: "App package project", workspaceName: "App package workspace" },
    ]);
  });

  test("groups the same repository subdirectory across hosts", async ({
    page,
    crossHostSubdirectoryProject,
  }) => {
    await openScenario(page, crossHostSubdirectoryProject);
    await expectProjectContainsWorkspaces(page, {
      projectName: GROUPED_PROJECT_NAME,
      workspaceNames: ["Primary app workspace", "Secondary app workspace"],
    });
  });

  test("keeps two clones of the same repository on one host separate", async ({
    page,
    sameHostClones,
  }) => {
    await openScenario(page, sameHostClones);
    await expectSeparateProjects(page, [
      { projectName: "First clone", workspaceName: "First clone workspace" },
      { projectName: "Second clone", workspaceName: "Second clone workspace" },
    ]);
  });

  test("renames only the selected host's grouped project", async ({ page, crossHostProject }) => {
    await openScenario(page, crossHostProject);
    await openGroupedProjectSettings(page, {
      serverId: getServerId(),
      projectName: GROUPED_PROJECT_NAME,
    });
    await renameProject(page, "Primary-only project name");
    await expectProjectSettingsName(page, "Primary-only project name");
    const secondaryHost = crossHostProject.hosts[0];
    if (!secondaryHost) throw new Error("Expected a secondary host");
    await openProjectsForSettingsHost(page, {
      serverId: secondaryHost.serverId,
      projectName: GROUPED_PROJECT_NAME,
    });
    await expectProjectSettingsName(page, GROUPED_PROJECT_NAME);
  });

  test("creates a workspace on the selected host from a grouped project", async ({
    page,
    crossHostProject,
  }) => {
    await openScenario(page, crossHostProject);
    await beginWorkspaceFromProject(page, GROUPED_PROJECT_NAME);
    await selectWorkspaceHost(page, SECONDARY_HOST_LABEL);
    await createWorkspaceWithoutAgent(page);
    await expectProjectWorkspaceCountForHost(page, {
      projectName: GROUPED_PROJECT_NAME,
      hostName: SECONDARY_HOST_LABEL,
      count: 2,
    });
  });
});
