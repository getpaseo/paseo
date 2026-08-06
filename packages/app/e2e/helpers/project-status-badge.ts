import { expect, type Page } from "@playwright/test";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

export interface StatusProject {
  seed: SeededWorkspace;
  needsInputWorkspaceId: string;
}

export async function seedStatusProject(): Promise<StatusProject> {
  const seed = await seedWorkspace({
    repoPrefix: "project-status-badge-",
    title: "Working workspace",
  });
  const created = await seed.client.createWorkspace({
    source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
    title: "Needs input workspace",
  });
  if (!created.workspace) {
    await seed.cleanup();
    throw new Error(created.error ?? "Failed to create the needs-input workspace");
  }
  return { seed, needsInputWorkspaceId: created.workspace.id };
}

export async function openAndCollapseStatusProject(
  page: Page,
  project: StatusProject,
): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await projectRow(page, project).click();
  await page.mouse.move(1200, 850);
  await expect(workspaceRow(page, "Working workspace")).toHaveCount(0);
}

export async function expandStatusProject(page: Page, project: StatusProject): Promise<void> {
  await projectRow(page, project).click();
  await expect(workspaceRow(page, "Working workspace")).toBeVisible();
}

export async function startWorkingWorkspace(project: StatusProject): Promise<void> {
  await project.seed.client.createAgent({
    provider: "mock",
    cwd: project.seed.repoPath,
    workspaceId: project.seed.workspaceId,
    title: "Working agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "keep streaming for the test",
  });
}

export async function startNeedsInputWorkspace(project: StatusProject): Promise<void> {
  await project.seed.client.createAgent({
    provider: "mock",
    cwd: project.seed.repoPath,
    workspaceId: project.needsInputWorkspaceId,
    title: "Needs input agent",
    modeId: "load-test",
    model: "thirty-minute-stream",
    initialPrompt: "emit a synthetic plan approval",
  });
}

export async function expectCollapsedProjectStatus(
  page: Page,
  project: StatusProject,
  status: "Working" | "Needs input",
): Promise<void> {
  await expect(projectRow(page, project).getByRole("status", { name: status })).toBeVisible({
    timeout: 60_000,
  });
}

export async function expectProjectStatusHidden(page: Page, project: StatusProject): Promise<void> {
  await expect(projectRow(page, project).getByRole("status")).toHaveCount(0, {
    timeout: 60_000,
  });
}

export async function expectWorkspaceStatus(
  page: Page,
  workspaceName: string,
  status: "running" | "needs_input",
): Promise<void> {
  await expect(
    workspaceRow(page, workspaceName).getByTestId(`workspace-status-indicator-${status}`),
  ).toBeVisible({ timeout: 60_000 });
}

function projectGroup(page: Page, project: StatusProject) {
  return page.getByRole("group", { name: project.seed.projectDisplayName, exact: true });
}

function projectRow(page: Page, project: StatusProject) {
  return projectGroup(page, project)
    .getByRole("button")
    .filter({ hasText: project.seed.projectDisplayName })
    .first();
}

function workspaceRow(page: Page, workspaceName: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(workspaceName)}(?:,|$)`),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
