import { expect, type Locator, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { addConnectedHostsAndReload, waitForConnectedHost } from "./hosts";
import { openProjectSettings } from "./project-settings";
import { waitForSidebarHydration } from "./workspace-ui";

const PROJECT_VISIBILITY_TIMEOUT = 30_000;

function projectGroup(page: Page, projectName: string): Locator {
  return page.getByRole("group", { name: projectName, exact: true });
}

function projectGroupWithWorkspace(
  page: Page,
  projectName: string,
  workspaceName: string,
): Locator {
  return projectGroup(page, projectName).filter({ hasText: workspaceName });
}

export async function openProjectDirectory(page: Page): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
}

export async function openProjectDirectoryWithHosts(
  page: Page,
  input: {
    hosts: Array<{ serverId: string; label: string; port: number }>;
    primaryLabel?: string;
  },
): Promise<void> {
  await gotoAppShell(page);
  await addConnectedHostsAndReload(page, input.hosts, { primaryLabel: input.primaryLabel });
  for (const host of input.hosts) {
    await waitForConnectedHost(page, {
      serverId: host.serverId,
      endpoint: `localhost:${host.port}`,
    });
  }
  await waitForSidebarHydration(page);
}

export async function expectProjectContainsWorkspaces(
  page: Page,
  input: { projectName: string; workspaceNames: string[] },
): Promise<void> {
  const group = projectGroup(page, input.projectName);
  await expect(group).toHaveCount(1, { timeout: PROJECT_VISIBILITY_TIMEOUT });
  for (const workspaceName of input.workspaceNames) {
    await expect(group.getByRole("button").filter({ hasText: workspaceName })).toBeVisible({
      timeout: PROJECT_VISIBILITY_TIMEOUT,
    });
  }
}

export async function expectSeparateProjects(
  page: Page,
  projects: Array<{ projectName: string; workspaceName: string }>,
): Promise<void> {
  for (const project of projects) {
    await expect(
      projectGroupWithWorkspace(page, project.projectName, project.workspaceName),
    ).toHaveCount(1, { timeout: PROJECT_VISIBILITY_TIMEOUT });
  }
}

export async function beginWorkspaceFromProject(page: Page, projectName: string): Promise<void> {
  const group = projectGroup(page, projectName);
  await expect(group).toBeVisible({ timeout: PROJECT_VISIBILITY_TIMEOUT });
  await group.hover();
  await group.getByLabel(`Create a new workspace for ${projectName}`).click();
  await expect(page.getByRole("button", { name: "Workspace project", exact: true })).toContainText(
    projectName,
    { timeout: PROJECT_VISIBILITY_TIMEOUT },
  );
}

export async function selectWorkspaceHost(page: Page, hostName: string): Promise<void> {
  await page.getByRole("button", { name: "Host", exact: true }).click();
  await page.getByRole("button", { name: hostName, exact: true }).click();
  await expect(page.getByRole("button", { name: "Host", exact: true })).toContainText(hostName);
}

export async function createWorkspaceWithoutAgent(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create", exact: true }).click();
}

export async function expectProjectWorkspaceCountForHost(
  page: Page,
  input: { projectName: string; hostName: string; count: number },
): Promise<void> {
  const group = projectGroup(page, input.projectName);
  await expect(group.getByRole("button").filter({ hasText: input.hostName })).toHaveCount(
    input.count,
    { timeout: PROJECT_VISIBILITY_TIMEOUT },
  );
}

export async function renameProject(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Rename project", exact: true }).click();
  await page.getByRole("textbox", { name: "Project name", exact: true }).fill(name);
  await page.getByRole("button", { name: "Save project name", exact: true }).click();
  await expect(page.getByText("Project renamed", { exact: true })).toBeVisible({
    timeout: PROJECT_VISIBILITY_TIMEOUT,
  });
}

export async function openGroupedProjectSettings(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/projects$/);
  await openProjectSettings(page, projectName);
}

export async function switchProjectSettingsHost(page: Page, hostName: string): Promise<void> {
  const projectSettings = page.getByRole("main");
  await projectSettings.getByRole("button", { name: "Switch host", exact: true }).click();
  await page.getByRole("button", { name: hostName, exact: true }).click();
  await expect(
    projectSettings.getByRole("button", { name: "Switch host", exact: true }),
  ).toContainText(hostName);
}

export async function expectProjectSettingsName(page: Page, projectName: string): Promise<void> {
  await expect(page.getByRole("group", { name: "Project name", exact: true })).toContainText(
    projectName,
    { timeout: PROJECT_VISIBILITY_TIMEOUT },
  );
}
