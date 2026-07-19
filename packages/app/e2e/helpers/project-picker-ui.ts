import { expect, type Page } from "@playwright/test";

export async function expectOpenedProject(page: Page, projectName: string): Promise<string> {
  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: projectName })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}
