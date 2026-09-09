import path from "node:path";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempDirectory } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test("shows project context as a right-aligned secondary label", async ({ page }) => {
  const directory = await createTempDirectory("project-secondary-label-");
  const client = await connectSeedClient();
  let projectId: string | null = null;

  try {
    const opened = await client.openProject(directory.path, undefined, {
      secondaryLabel: "devbox.example.com",
    });
    expect(opened.error).toBeNull();
    expect(opened.workspace).not.toBeNull();
    projectId = opened.workspace!.projectId;

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const row = page
      .locator('[data-testid^="sidebar-project-row-"]')
      .filter({ hasText: path.basename(directory.path) })
      .first();
    const primary = row.locator('[data-testid^="sidebar-project-primary-label-"]');
    const secondary = row.locator('[data-testid^="sidebar-project-secondary-label-"]');

    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(primary).toHaveText(path.basename(directory.path));
    await expect(secondary).toHaveText("devbox.example.com");

    const primaryBounds = await primary.boundingBox();
    const secondaryBounds = await secondary.boundingBox();
    expect(primaryBounds).not.toBeNull();
    expect(secondaryBounds).not.toBeNull();
    expect(secondaryBounds!.x).toBeGreaterThan(primaryBounds!.x);
    expect(secondaryBounds!.x + secondaryBounds!.width).toBeLessThanOrEqual(
      (await row.boundingBox())!.x + (await row.boundingBox())!.width,
    );
  } finally {
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
    await client.close().catch(() => undefined);
    await directory.cleanup().catch(() => undefined);
  }
});
