import { expect, type Page } from "@playwright/test";

export async function expectOpenedProject(page: Page, projectName: string): Promise<string> {
  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: projectName })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  await expect(page).toHaveURL(/\/new\?.*projectId=/u, { timeout: 30_000 });
  const projectId = new URL(page.url()).searchParams.get("projectId");
  expect(projectId).not.toBeNull();
  return projectId!;
}
