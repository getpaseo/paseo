import { test, expect } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  seedProjectForWorkspaceSetup,
} from "../support/helpers/workspace-setup";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

test("configured launches expose their start control in a worktree", async ({ page }) => {
  const client = await connectWorkspaceSetupClient();
  const repo = await createTempGitRepo("workspace-launches-", {
    paseoConfig: {
      launches: {
        dev: {
          command: "node -e \"process.stdout.write('launch ready')\"",
        },
      },
    },
  });

  try {
    await seedProjectForWorkspaceSetup(client, repo.path);
    const workspace = await createWorkspaceThroughDaemon(client, {
      cwd: repo.path,
      worktreeSlug: `workspace-launches-${Date.now()}`,
    });

    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);

    const launchesButton = page.getByTestId("workspace-launches-button");
    await expect(launchesButton).toBeVisible({ timeout: 30_000 });
    await launchesButton.click();

    await expect(page.getByTestId("workspace-launches-menu")).toBeVisible();
    await expect(page.getByTestId("workspace-launches-item-dev")).toBeVisible();
    await expect(page.getByTestId("workspace-launches-start-dev")).toBeVisible();
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
