import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  addConnectedHostAndReload,
  addConnectedHostsAndReload,
  waitForConnectedHost,
} from "./helpers/hosts";
import { type IsolatedHostDaemon, startIsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import { connectSeedClient, type SeedDaemonClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo, type TempDirectory } from "./helpers/workspace";

const SECONDARY_HOST_ID = "project-grouping-secondary";
const SECONDARY_HOST_LABEL = "Secondary Host";
const LEGACY_PRIMARY_HOST_ID = "project-grouping-legacy-primary";
const LEGACY_SECONDARY_HOST_ID = "project-grouping-legacy-secondary";
const SHARED_REMOTE_URL = "https://github.com/paseo-e2e/grouped-project.git";
const SHARED_LEGACY_PROJECT_ID = "remote:github.com/paseo-e2e/grouped-project";

interface HostProject {
  serverId: string;
  projectId: string;
  workspaceId: string;
}

interface CrossHostProject {
  secondaryHost: IsolatedHostDaemon;
  primary: HostProject;
  secondary: HostProject;
}

interface ReconciledCrossHostProject extends CrossHostProject {
  primaryHost: IsolatedHostDaemon;
}

async function createProject(
  client: SeedDaemonClient,
  repo: TempDirectory,
  serverId: string,
): Promise<HostProject> {
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create project on ${serverId}`);
  }
  return {
    serverId,
    projectId: created.workspace.projectId,
    workspaceId: created.workspace.id,
  };
}

async function expectOneProjectContainsBothWorkspaces(
  page: Page,
  fixture: CrossHostProject,
): Promise<void> {
  const primaryWorkspace = page.getByTestId(
    `sidebar-workspace-row-${fixture.primary.serverId}:${fixture.primary.workspaceId}`,
  );
  const secondaryWorkspace = page.getByTestId(
    `sidebar-workspace-row-${fixture.secondary.serverId}:${fixture.secondary.workspaceId}`,
  );
  await expect(primaryWorkspace).toBeVisible({ timeout: 30_000 });
  await expect(secondaryWorkspace).toBeVisible({ timeout: 30_000 });

  await expect(page.locator('[data-testid^="sidebar-project-row-"]')).toHaveCount(1);
}

async function openGroupedProjectSettings(page: Page): Promise<void> {
  const projectRow = page.locator('[data-testid^="sidebar-project-row-"]').first();
  const testId = await projectRow.getAttribute("data-testid");
  if (!testId) throw new Error("Grouped project row has no test ID");
  const projectKey = testId.slice("sidebar-project-row-".length);
  await projectRow.hover();
  await page.getByTestId(`sidebar-project-kebab-${projectKey}`).click();
  await page.getByTestId(`sidebar-project-menu-open-settings-${projectKey}`).click();
  await expect(page.getByTestId("host-picker")).toBeVisible({ timeout: 30_000 });
}

async function readPersistedProjectGroupKey(host: IsolatedHostDaemon): Promise<unknown> {
  const projectsPath = path.join(host.paseoHome, "projects", "projects.json");
  const projects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  return projects[0]?.projectGroupKey;
}

async function removePersistedProjectGroupKeys(host: IsolatedHostDaemon): Promise<void> {
  const projectsPath = path.join(host.paseoHome, "projects", "projects.json");
  const projects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  for (const project of projects) {
    delete project.projectGroupKey;
  }
  await writeFile(projectsPath, JSON.stringify(projects));
  const persisted = JSON.parse(await readFile(projectsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  expect(persisted.every((project) => !("projectGroupKey" in project))).toBe(true);
}

async function rewritePersistedProjectId(
  host: IsolatedHostDaemon,
  previousProjectId: string,
  nextProjectId: string,
): Promise<void> {
  const projectsDirectory = path.join(host.paseoHome, "projects");
  const projectsPath = path.join(projectsDirectory, "projects.json");
  const workspacesPath = path.join(projectsDirectory, "workspaces.json");
  const projects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  const workspaces = JSON.parse(await readFile(workspacesPath, "utf8")) as Array<
    Record<string, unknown>
  >;
  for (const project of projects) {
    if (project.projectId === previousProjectId) project.projectId = nextProjectId;
  }
  for (const workspace of workspaces) {
    if (workspace.projectId === previousProjectId) workspace.projectId = nextProjectId;
  }
  await Promise.all([
    writeFile(projectsPath, JSON.stringify(projects)),
    writeFile(workspacesPath, JSON.stringify(workspaces)),
  ]);
}

async function createReconciliationFixture(options?: { sharedLegacyProjectId?: string }): Promise<{
  fixture: ReconciledCrossHostProject;
  cleanup: () => Promise<void>;
}> {
  const primaryHost = await startIsolatedHostDaemon(LEGACY_PRIMARY_HOST_ID);
  const secondaryHost = await startIsolatedHostDaemon(LEGACY_SECONDARY_HOST_ID);
  const primaryRepo = await createTempGitRepo("grouped-legacy-primary-", {
    originUrl: SHARED_REMOTE_URL,
  });
  const secondaryRepo = await createTempGitRepo("grouped-legacy-secondary-", {
    originUrl: SHARED_REMOTE_URL,
  });
  const primaryClient = await connectSeedClient({ port: primaryHost.port });
  const secondaryClient = await connectSeedClient({ port: secondaryHost.port });

  try {
    let primary = await createProject(primaryClient, primaryRepo, primaryHost.serverId);
    let secondary = await createProject(secondaryClient, secondaryRepo, secondaryHost.serverId);
    await primaryClient.close();
    await secondaryClient.close();
    await removePersistedProjectGroupKeys(primaryHost);
    await removePersistedProjectGroupKeys(secondaryHost);
    if (options?.sharedLegacyProjectId) {
      await Promise.all([
        rewritePersistedProjectId(primaryHost, primary.projectId, options.sharedLegacyProjectId),
        rewritePersistedProjectId(
          secondaryHost,
          secondary.projectId,
          options.sharedLegacyProjectId,
        ),
      ]);
      primary = { ...primary, projectId: options.sharedLegacyProjectId };
      secondary = { ...secondary, projectId: options.sharedLegacyProjectId };
    }
    await Promise.all([primaryHost.restart(), secondaryHost.restart()]);
    return {
      fixture: { primaryHost, secondaryHost, primary, secondary },
      cleanup: async () => {
        await primaryHost.close().catch(() => undefined);
        await secondaryHost.close().catch(() => undefined);
        await primaryRepo.cleanup().catch(() => undefined);
        await secondaryRepo.cleanup().catch(() => undefined);
      },
    };
  } catch (error) {
    await primaryClient.close().catch(() => undefined);
    await secondaryClient.close().catch(() => undefined);
    await primaryHost.close().catch(() => undefined);
    await secondaryHost.close().catch(() => undefined);
    await primaryRepo.cleanup().catch(() => undefined);
    await secondaryRepo.cleanup().catch(() => undefined);
    throw error;
  }
}

const test = base.extend<{
  crossHostProject: CrossHostProject;
  reconciledCrossHostProject: ReconciledCrossHostProject;
  sharedLegacyIdCrossHostProject: ReconciledCrossHostProject;
}>({
  crossHostProject: async ({ page: _page }, provide) => {
    const secondaryHost = await startIsolatedHostDaemon(SECONDARY_HOST_ID);
    const primaryRepo = await createTempGitRepo("grouped-primary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const secondaryRepo = await createTempGitRepo("grouped-secondary-", {
      originUrl: SHARED_REMOTE_URL,
    });
    const primaryClient = await connectSeedClient();
    const secondaryClient = await connectSeedClient({ port: secondaryHost.port });
    let primary: HostProject | null = null;
    let secondary: HostProject | null = null;

    try {
      primary = await createProject(primaryClient, primaryRepo, getServerId());
      secondary = await createProject(secondaryClient, secondaryRepo, secondaryHost.serverId);
      await provide({ secondaryHost, primary, secondary });
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
    const resource = await createReconciliationFixture();
    try {
      await provide(resource.fixture);
    } finally {
      await resource.cleanup();
    }
  },
  sharedLegacyIdCrossHostProject: async ({ page: _page }, provide) => {
    const resource = await createReconciliationFixture({
      sharedLegacyProjectId: SHARED_LEGACY_PROJECT_ID,
    });
    try {
      await provide(resource.fixture);
    } finally {
      await resource.cleanup();
    }
  },
});

test.describe("Sidebar project grouping", () => {
  test.describe.configure({ timeout: 120_000 });

  test("groups projects with the same Git remote across hosts", async ({
    page,
    crossHostProject,
  }) => {
    expect(crossHostProject.primary.projectId).not.toBe(crossHostProject.secondary.projectId);
    await gotoAppShell(page);
    await addConnectedHostAndReload(page, {
      serverId: crossHostProject.secondaryHost.serverId,
      label: SECONDARY_HOST_LABEL,
      port: crossHostProject.secondaryHost.port,
    });
    await waitForConnectedHost(page, {
      serverId: crossHostProject.secondaryHost.serverId,
      endpoint: `localhost:${crossHostProject.secondaryHost.port}`,
    });
    await expectOneProjectContainsBothWorkspaces(page, crossHostProject);
  });

  test("groups persisted projects missing group keys after app boot", async ({
    page,
    reconciledCrossHostProject,
  }) => {
    expect(reconciledCrossHostProject.primary.projectId).not.toBe(
      reconciledCrossHostProject.secondary.projectId,
    );
    await gotoAppShell(page);
    await addConnectedHostsAndReload(page, [
      {
        serverId: reconciledCrossHostProject.primaryHost.serverId,
        label: "Legacy Primary Host",
        port: reconciledCrossHostProject.primaryHost.port,
      },
      {
        serverId: reconciledCrossHostProject.secondaryHost.serverId,
        label: "Legacy Secondary Host",
        port: reconciledCrossHostProject.secondaryHost.port,
      },
    ]);
    await waitForConnectedHost(page, {
      serverId: reconciledCrossHostProject.primaryHost.serverId,
      endpoint: `localhost:${reconciledCrossHostProject.primaryHost.port}`,
    });
    await waitForConnectedHost(page, {
      serverId: reconciledCrossHostProject.secondaryHost.serverId,
      endpoint: `localhost:${reconciledCrossHostProject.secondaryHost.port}`,
    });
    await expectOneProjectContainsBothWorkspaces(page, reconciledCrossHostProject);
    await expect
      .poll(() => readPersistedProjectGroupKey(reconciledCrossHostProject.primaryHost))
      .toBe("remote:github.com/paseo-e2e/grouped-project");
    await expect
      .poll(() => readPersistedProjectGroupKey(reconciledCrossHostProject.secondaryHost))
      .toBe("remote:github.com/paseo-e2e/grouped-project");
  });

  test("resets a rename draft when switching grouped-project hosts", async ({
    page,
    sharedLegacyIdCrossHostProject,
  }) => {
    expect(sharedLegacyIdCrossHostProject.primary.projectId).toBe(
      sharedLegacyIdCrossHostProject.secondary.projectId,
    );
    await gotoAppShell(page);
    await addConnectedHostsAndReload(page, [
      {
        serverId: sharedLegacyIdCrossHostProject.primaryHost.serverId,
        label: "Legacy Primary Host",
        port: sharedLegacyIdCrossHostProject.primaryHost.port,
      },
      {
        serverId: sharedLegacyIdCrossHostProject.secondaryHost.serverId,
        label: "Legacy Secondary Host",
        port: sharedLegacyIdCrossHostProject.secondaryHost.port,
      },
    ]);
    await waitForConnectedHost(page, {
      serverId: sharedLegacyIdCrossHostProject.primaryHost.serverId,
      endpoint: `localhost:${sharedLegacyIdCrossHostProject.primaryHost.port}`,
    });
    await waitForConnectedHost(page, {
      serverId: sharedLegacyIdCrossHostProject.secondaryHost.serverId,
      endpoint: `localhost:${sharedLegacyIdCrossHostProject.secondaryHost.port}`,
    });
    await expectOneProjectContainsBothWorkspaces(page, sharedLegacyIdCrossHostProject);
    await openGroupedProjectSettings(page);

    await page.getByTestId("project-name-edit-button").click();
    const nameInput = page.getByTestId("project-name-input");
    await nameInput.fill("Draft from the first host");

    await page.getByTestId("host-picker").click();
    await page
      .getByTestId(`host-picker-item-${sharedLegacyIdCrossHostProject.secondary.serverId}`)
      .click();

    await expect(nameInput).not.toBeVisible();
    await page.getByTestId("project-name-edit-button").click();
    await expect(page.getByTestId("project-name-input")).toHaveValue("");
  });
});
