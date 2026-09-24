import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { expectComposerVisible } from "../support/helpers/composer";
import { clickNewChat } from "../support/helpers/launcher";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

test("New Agent promotes transcript attachment and shows recent agents without a query", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "agent-context-attachment-" });
  const pluginClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previousConfig = await pluginClient.getDaemonConfig();
  const plugin = await copyPluginExample("agent-context");

  try {
    const sourceAgent = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Recent context source",
      modeId: "load-test",
      model: "e2e-fast-stream",
      initialPrompt: "Create context for the next agent.",
    });
    await workspace.client.waitForFinish(sourceAgent.id, 15_000);

    await pluginClient.patchDaemonConfig({ pluginsEnabled: true });
    await pluginClient.installDirectoryPlugin(plugin.directory);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: workspace.workspaceId,
    });
    await clickNewChat(page);
    await expectComposerVisible(page);

    const shortcut = page.getByRole("button", {
      name: "Attach agent transcript",
      exact: true,
    });
    await expect(shortcut).toBeVisible({ timeout: 30_000 });
    await shortcut.click();

    await expect(page.getByPlaceholder("Search agents", { exact: true })).toBeVisible();
    const recentAgent = page.getByRole("button", { name: /Recent context source/ });
    await expect(recentAgent).toBeVisible({ timeout: 30_000 });
    await recentAgent.click();

    await expect(page.getByTestId("composer-plugin-resource-attachment-pill")).toContainText(
      "Recent context source",
    );
  } finally {
    await pluginClient.removePlugin("agent-context").catch(() => undefined);
    await pluginClient
      .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await pluginClient.close().catch(() => undefined);
    await plugin.cleanup();
    await workspace.cleanup();
  }
});
