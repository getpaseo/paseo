import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { createIdleAgent } from "./helpers/archive-tab";
import { expectComposerVisible } from "./helpers/composer";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";

test.describe("Workspace pane mounting", () => {
  test("opening the first split pane keeps the existing agent composer mounted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = getServerId();

    const workspace = await seedWorkspace({ repoPrefix: "pane-remount-" });

    try {
      const agent = await createIdleAgent(workspace.client, {
        cwd: workspace.repoPath,
        title: `pane-remount-${Date.now()}`,
      });

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.workspaceId));
      await page.waitForURL(
        (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
        { timeout: 60_000 },
      );
      await waitForWorkspaceTabsVisible(page);
      await expectComposerVisible(page);

      const originalComposer = await page
        .getByTestId("message-input-root")
        .filter({ visible: true })
        .first()
        .elementHandle();
      expect(originalComposer).not.toBeNull();

      await page.getByRole("button", { name: "Split pane right" }).first().click();
      await expect(page.getByTestId("message-input-root").filter({ visible: true })).toHaveCount(
        2,
        { timeout: 30_000 },
      );

      const originalStillConnected = await originalComposer!.evaluate((node) => node.isConnected);
      expect(originalStillConnected).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});
