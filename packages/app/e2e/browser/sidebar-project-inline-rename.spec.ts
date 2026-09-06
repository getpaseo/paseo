import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";

async function fetchProjectName(
  client: SeedDaemonClient,
  projectId: string,
): Promise<string | null> {
  const result = await client.fetchWorkspaces({ filter: { projectId } });
  return result.entries[0]?.projectDisplayName ?? null;
}

test.describe("Sidebar project inline rename", () => {
  test("double-clicking a project title opens inline rename", async ({ page }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "sidebar-project-inline-rename-" });

    try {
      await gotoAppShell(page);

      const title = page.getByTestId(`sidebar-project-title-${workspace.projectKey}`);
      await expect(title).toBeVisible({ timeout: 30_000 });
      await expect(title).toContainText(workspace.projectDisplayName);
      await title.dblclick();

      const input = page.getByTestId(`sidebar-project-inline-rename-${workspace.projectKey}`);
      await expect(input).toBeVisible({ timeout: 10_000 });
      await expect(input).toHaveValue(workspace.projectDisplayName);

      const renamed = "Inline Renamed Project";
      await input.fill(renamed);
      await input.press("Enter");

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(title).toContainText(renamed, { timeout: 15_000 });
      await expect
        .poll(() => fetchProjectName(workspace.client, workspace.projectId))
        .toBe(renamed);
    } finally {
      await workspace.cleanup();
    }
  });

  test("pressing Escape cancels project inline rename", async ({ page }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "sidebar-project-inline-cancel-" });

    try {
      await gotoAppShell(page);

      const title = page.getByTestId(`sidebar-project-title-${workspace.projectKey}`);
      await expect(title).toBeVisible({ timeout: 30_000 });
      await expect(title).toContainText(workspace.projectDisplayName);
      await title.dblclick();

      const input = page.getByTestId(`sidebar-project-inline-rename-${workspace.projectKey}`);
      await expect(input).toBeVisible({ timeout: 10_000 });

      await input.fill("Do Not Save Project");
      await input.press("Escape");

      await expect(input).toHaveCount(0, { timeout: 10_000 });
      await expect(title).toContainText(workspace.projectDisplayName, { timeout: 10_000 });
      await expect
        .poll(() => fetchProjectName(workspace.client, workspace.projectId))
        .toBe(workspace.projectDisplayName);
    } finally {
      await workspace.cleanup();
    }
  });
});
