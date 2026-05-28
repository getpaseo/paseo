import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import {
  archiveAgentFromDaemon,
  connectArchiveTabDaemonClient,
  createIdleAgent,
} from "./helpers/archive-tab";
import { expectComposerVisible } from "./helpers/composer";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";

test.describe("Workspace pane mounting", () => {
  test("opening the first split pane keeps the existing agent composer mounted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const client = await connectArchiveTabDaemonClient();
    const repo = await createTempGitRepo("pane-remount-");
    let agentId: string | null = null;

    try {
      const agent = await createIdleAgent(client, {
        cwd: repo.path,
        title: `pane-remount-${Date.now()}`,
      });
      agentId = agent.id;

      await page.goto(buildHostAgentDetailRoute(serverId, agent.id, agent.cwd));
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
      if (agentId) {
        await archiveAgentFromDaemon(client, agentId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup();
    }
  });
});
