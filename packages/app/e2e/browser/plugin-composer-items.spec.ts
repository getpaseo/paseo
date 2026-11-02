import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

const NARROW = { width: 500, height: 800 };

test("a narrow composer's overflow sheet shows a plugin item's row", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({
    repoPrefix: "composer-items-",
    title: "Composer items",
  });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Composer items agent",
    model: "ten-second-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const example = await copyPluginExample("composer-controls");
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    await page.setViewportSize(NARROW);
    await gotoAppShell(page);
    await page.goto(buildAgentRoute(workspace.workspaceId, agent.id));

    await page.getByRole("button", { name: "Open agent features", exact: true }).click();

    await expect(page.getByRole("button", { name: "Needs review", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Insert checklist", exact: true })).toBeVisible();
  } finally {
    await client.removePlugin("composer-controls-example");
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await example.cleanup();
    await workspace.cleanup();
  }
});
