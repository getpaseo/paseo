import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test as base } from "../support/fixtures";
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
} from "../support/helpers/project-grouping";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { connectSeedClient, type SeedDaemonClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openSidebarDisplayPage, closeSidebarDisplayPreferences } from "../support/helpers/sidebar";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_LABEL = "Secondary Host";
const LEGACY_PRIMARY_HOST_LABEL = "Legacy Primary Host";
const LEGACY_SECONDARY_HOST_LABEL = "Legacy Secondary Host";
const GROUPED_PROJECT_NAME = "paseo-e2e/grouped-project";
const HOST_LOCAL_PROJECT_NAME = "Host local project";
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
  crossHostWithMultipleProjects: ProjectDirectoryScenario;
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

  crossHostWithMultipleProjects: async ({ crossHostProject }, provide) => {
    const repo = await createTempGitRepo("host-local-project-", {
      originUrl: "https://github.com/paseo-e2e/host-local-project.git",
    });
    const client = await connectSeedClient();
    let project: CreatedProject | null = null;
    try {
      project = await createProject(client, {
        projectPath: repo.path,
        serverId: getServerId(),
        workspaceName: "Host local workspace",
        projectName: HOST_LOCAL_PROJECT_NAME,
      });
      await provide(crossHostProject);
    } finally {
      if (project) await client.removeProject(project.projectId).catch(() => undefined);
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
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
    const primaryClient = await connectSeedClient({
      port: primaryHost.port,
      projectOwnership: "host",
    });
    const secondaryClient = await connectSeedClient({
      port: secondaryHost.port,
      projectOwnership: "host",
    });

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

async function dragHeaderOnto(source: Locator, target: Locator): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Expected visible draggable headers");
  const page = source.page();
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX, sourceY + 7);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
}

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function reloadScenario(page: Page): Promise<void> {
  // Preserve the connected hosts when the fixture's init script runs on reload.
  await page.evaluate(() => {
    const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
    if (!nonce) throw new Error("Expected the e2e seed nonce before reloading.");
    localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
  });
  await page.reload();
}

test.describe("Sidebar project grouping", () => {
  test.describe.configure({ timeout: 120_000 });

  test("host-project grouping separates shared projects and remembers collapsed hosts", async ({
    page,
    crossHostProject,
  }, testInfo) => {
    await openScenario(page, crossHostProject);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-host-project").click();
    await closeSidebarDisplayPreferences(page);
    const primary = page.getByRole("group", { name: PRIMARY_HOST_LABEL, exact: true });
    const secondary = page.getByRole("group", { name: SECONDARY_HOST_LABEL, exact: true });
    await expect(
      primary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true }),
    ).toHaveCount(1);
    await expect(
      secondary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true }),
    ).toHaveCount(1);
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
    await expect(primary.getByText("Secondary workspace", { exact: true })).toHaveCount(0);
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await expect(secondary.getByText("Primary workspace", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("host-project-groups.png"), fullPage: true });

    await primary.getByRole("button", { name: PRIMARY_HOST_LABEL, exact: true }).click();
    await expect(
      primary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true }),
    ).toHaveCount(0);
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await reloadScenario(page);
    await expect(primary).toBeVisible();
    await expect(
      primary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true }),
    ).toHaveCount(0);
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await primary.getByRole("button", { name: PRIMARY_HOST_LABEL, exact: true }).click();
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
  });

  test("host-project grouping reorders expanded and collapsed hosts and persists their order", async ({
    page,
    crossHostProject,
  }, testInfo) => {
    await openScenario(page, crossHostProject);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-host-project").click();
    await closeSidebarDisplayPreferences(page);
    const primary = page.getByRole("group", { name: PRIMARY_HOST_LABEL, exact: true });
    const secondary = page.getByRole("group", { name: SECONDARY_HOST_LABEL, exact: true });
    const primaryHeader = primary.getByRole("button", { name: PRIMARY_HOST_LABEL, exact: true });
    const secondaryHeader = secondary.getByRole("button", {
      name: SECONDARY_HOST_LABEL,
      exact: true,
    });
    const hostRows = page.locator('[data-testid^="sidebar-host-header-"]');
    await expect(hostRows).toHaveCount(2);
    const before = await rowTestIds(hostRows);
    await dragHeaderOnto(primaryHeader, secondaryHeader);
    await expect.poll(() => rowTestIds(hostRows)).toEqual([before[1], before[0]]);
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await reloadScenario(page);
    await expect.poll(() => rowTestIds(hostRows)).toEqual([before[1], before[0]]);
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("reordered-host-project-groups.png"),
      fullPage: true,
    });

    await primaryHeader.click();
    await secondaryHeader.click();
    await dragHeaderOnto(secondaryHeader, primaryHeader);
    await expect.poll(() => rowTestIds(hostRows)).toEqual(before);
    await expect(primaryHeader).toHaveAttribute("aria-expanded", "false");
    await expect(secondaryHeader).toHaveAttribute("aria-expanded", "false");
  });

  test("host-project grouping reorders projects within a host and prevents moving them to another host", async ({
    page,
    crossHostWithMultipleProjects,
  }) => {
    await openScenario(page, crossHostWithMultipleProjects);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-host-project").click();
    await closeSidebarDisplayPreferences(page);
    const primary = page.getByRole("group", { name: PRIMARY_HOST_LABEL, exact: true });
    const secondary = page.getByRole("group", { name: SECONDARY_HOST_LABEL, exact: true });
    const projectRows = primary.locator('[data-testid^="sidebar-project-row-"]');
    await expect(projectRows).toHaveCount(2);
    const before = await rowTestIds(projectRows);
    await dragHeaderOnto(projectRows.nth(0), projectRows.nth(1));
    await expect.poll(() => rowTestIds(projectRows)).toEqual([before[1], before[0]]);
    const sharedProject = primary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true });
    const secondaryProject = secondary.getByRole("group", {
      name: GROUPED_PROJECT_NAME,
      exact: true,
    });
    const hostRows = page.locator('[data-testid^="sidebar-host-header-"]');
    await expect(hostRows).toHaveCount(2);
    const hostOrder = await rowTestIds(hostRows);
    await dragHeaderOnto(
      sharedProject.locator('[data-testid^="sidebar-project-row-"]'),
      secondaryProject.locator('[data-testid^="sidebar-project-row-"]'),
    );
    await expect.poll(() => rowTestIds(hostRows)).toEqual(hostOrder);
    await expect(
      primary.getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true }),
    ).toHaveCount(1);
    await expect(
      primary.getByRole("group", { name: HOST_LOCAL_PROJECT_NAME, exact: true }),
    ).toHaveCount(1);
    await expect(
      secondary.getByRole("group", { name: HOST_LOCAL_PROJECT_NAME, exact: true }),
    ).toHaveCount(0);
    await expect(secondaryProject).toHaveCount(1);
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
    await expect(secondary.getByText("Primary workspace", { exact: true })).toHaveCount(0);
    await expect(secondary.getByText("Secondary workspace", { exact: true })).toBeVisible();
    await reloadScenario(page);
    await expect(primary.getByText("Primary workspace", { exact: true })).toBeVisible();
    await expect(primary.getByText("Host local workspace", { exact: true })).toBeVisible();
    await expect(secondary.getByText("Primary workspace", { exact: true })).toHaveCount(0);
  });

  test("host-project grouping creates workspaces on the project header's host", async ({
    page,
    crossHostProject,
  }) => {
    await openScenario(page, crossHostProject);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-host-project").click();
    await closeSidebarDisplayPreferences(page);
    const project = page
      .getByRole("group", { name: SECONDARY_HOST_LABEL, exact: true })
      .getByRole("group", { name: GROUPED_PROJECT_NAME, exact: true });
    await project.hover();
    await project.getByLabel("Create a new workspace for " + GROUPED_PROJECT_NAME).click();
    await expect(page.getByRole("button", { name: "Host", exact: true })).toContainText(
      SECONDARY_HOST_LABEL,
    );
    await expect(
      page.getByRole("button", { name: "Workspace project", exact: true }),
    ).toContainText(GROUPED_PROJECT_NAME);
  });

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
