import { expect, type Page } from "@playwright/test";

export async function expectOpenedProject(page: Page, _projectName?: string): Promise<string> {
  await expect(page).toHaveURL(/\/new\?.*projectId=/u, { timeout: 30_000 });
  const projectId = new URL(page.url()).searchParams.get("projectId");
  expect(projectId).not.toBeNull();
  return projectId!;
}
