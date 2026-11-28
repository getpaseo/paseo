import { test, expect, type Page } from "../support/fixtures";
import { composerLocator } from "../support/helpers/composer";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForTabBar } from "../support/helpers/launcher";
import { buildHostWorkspaceRoute, buildProjectSettingsRoute } from "@/utils/host-routes";

function setupCallout(page: Page, workspace: SeededWorkspace) {
  return page.getByTestId(`worktree-setup-callout-${workspace.projectId}`);
}

async function openWorkspaceWithoutSetup(page: Page): Promise<SeededWorkspace> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The default repo fixture has no paseo.json, so it has no worktree setup.
  const workspace = await seedWorkspace({ repoPrefix: "worktree-setup-callout-" });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
  await waitForTabBar(page);
  await expect(setupCallout(page, workspace)).toBeVisible({ timeout: 15_000 });
  return workspace;
}

test.describe("Worktree setup callout", () => {
  test("Ask agent opens an agent draft pre-filled with the worktree setup prompt", async ({
    page,
  }) => {
    const workspace = await openWorkspaceWithoutSetup(page);
    try {
      await setupCallout(page, workspace).getByRole("button", { name: "Ask agent" }).click();

      await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}`));
      const composer = composerLocator(page);
      await expect(composer).toHaveValue(/^Set up Paseo worktree config for this repository\./, {
        timeout: 15_000,
      });
      await expect(composer).toHaveValue(/create or update `paseo\.json` in the repo root/);
    } finally {
      await workspace.cleanup();
    }
  });

  test("Add manually opens the project's settings", async ({ page }) => {
    const workspace = await openWorkspaceWithoutSetup(page);
    try {
      await setupCallout(page, workspace).getByRole("button", { name: "Add manually" }).click();

      await expect(page).toHaveURL(
        new RegExp(`${buildProjectSettingsRoute(getServerId(), workspace.projectId)}$`),
      );
    } finally {
      await workspace.cleanup();
    }
  });
});
