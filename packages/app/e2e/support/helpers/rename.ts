import { expect, type Locator, type Page } from "@playwright/test";
import type { SeedDaemonClient } from "./seed-client";

export function renameModalInput(page: Page, testIdPrefix: string): Locator {
  return page.getByTestId(`${testIdPrefix}-input`);
}

export function renameModalSubmit(page: Page, testIdPrefix: string): Locator {
  return page.getByTestId(`${testIdPrefix}-submit`);
}

export function renameModalError(page: Page, testIdPrefix: string): Locator {
  return page.getByTestId(`${testIdPrefix}-error`);
}

// --- Project inline rename DSL ---

export function projectTitleLocator(page: Page, projectKey: string): Locator {
  return page.getByTestId(`sidebar-project-title-${projectKey}`);
}

export function projectInlineRenameInput(page: Page, projectKey: string): Locator {
  return page.getByTestId(`sidebar-project-inline-rename-${projectKey}`);
}

export async function expectProjectTitle(
  page: Page,
  projectKey: string,
  expectedTitle: string,
): Promise<void> {
  await expect(projectTitleLocator(page, projectKey)).toContainText(expectedTitle, {
    timeout: 30_000,
  });
}

export async function startProjectInlineRename(page: Page, projectKey: string): Promise<Locator> {
  const title = projectTitleLocator(page, projectKey);
  await expect(title).toBeVisible({ timeout: 30_000 });
  await title.dblclick();

  const input = projectInlineRenameInput(page, projectKey);
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

export async function submitProjectInlineRename(
  page: Page,
  projectKey: string,
  nextName: string,
): Promise<void> {
  const input = projectInlineRenameInput(page, projectKey);
  await input.fill(nextName);
  await input.press("Enter");
  await expect(input).toHaveCount(0, { timeout: 15_000 });
}

export async function cancelProjectInlineRename(page: Page, projectKey: string): Promise<void> {
  const input = projectInlineRenameInput(page, projectKey);
  await input.press("Escape");
  await expect(input).toHaveCount(0, { timeout: 10_000 });
}

export async function expectProjectNameOnDaemon(
  client: SeedDaemonClient,
  projectId: string,
  expectedName: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await client.fetchWorkspaces({ filter: { projectId } });
      return result.entries[0]?.projectDisplayName ?? null;
    })
    .toBe(expectedName);
}

// --- Workspace Tab inline rename DSL ---

export function workspaceTabLocator(page: Page, kind: "agent" | "terminal", id: string): Locator {
  return page.getByTestId(`workspace-tab-${kind}_${id}`).first();
}

export function workspaceTabInlineRenameInput(
  page: Page,
  kind: "agent" | "terminal",
  id: string,
): Locator {
  return page.getByTestId(`workspace-tab-inline-rename-${kind}_${id}`).first();
}

export async function expectWorkspaceTabTitle(
  page: Page,
  kind: "agent" | "terminal",
  id: string,
  expectedTitle: string,
): Promise<void> {
  await expect(workspaceTabLocator(page, kind, id)).toContainText(expectedTitle, {
    timeout: 15_000,
  });
}

export async function startWorkspaceTabInlineRename(
  page: Page,
  kind: "agent" | "terminal",
  id: string,
): Promise<Locator> {
  const tab = workspaceTabLocator(page, kind, id);
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.dblclick();

  const input = workspaceTabInlineRenameInput(page, kind, id);
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

export async function submitWorkspaceTabInlineRename(
  page: Page,
  kind: "agent" | "terminal",
  id: string,
  nextTitle: string,
): Promise<void> {
  const input = workspaceTabInlineRenameInput(page, kind, id);
  await input.fill(nextTitle);
  await input.press("Enter");
  await expect(input).toHaveCount(0, { timeout: 15_000 });
}

export async function cancelWorkspaceTabInlineRename(
  page: Page,
  kind: "agent" | "terminal",
  id: string,
): Promise<void> {
  const input = workspaceTabInlineRenameInput(page, kind, id);
  await input.press("Escape");
  await expect(input).toHaveCount(0, { timeout: 10_000 });
}

export async function expectAgentTitleOnDaemon(
  client: SeedDaemonClient,
  agentId: string,
  expectedTitle: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const result = await client.fetchAgents({ scope: "active" });
      return result.entries.find((entry) => entry.agent.id === agentId)?.agent.title ?? null;
    })
    .toBe(expectedTitle);
}
