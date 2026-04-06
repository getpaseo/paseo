import { randomUUID } from "node:crypto";
import { test } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectArchiveTabDaemonClient,
  createIdleAgent,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  openWorkspaceWithAgents,
  reloadWorkspace,
} from "./helpers/archive-tab";
import {
  middleClickWorkspaceTab,
  waitForWorkspaceTabsVisible,
} from "./helpers/workspace-tabs";

test.describe("Workspace middle-click close", () => {
  let client: Awaited<ReturnType<typeof connectArchiveTabDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };

  test.beforeAll(async () => {
    tempRepo = await createTempGitRepo("middle-click-close-tab-");
    client = await connectArchiveTabDaemonClient();
  });

  test.afterAll(async () => {
    await client?.close();
    await tempRepo?.cleanup();
  });

  test("middle click closes the workspace tab and persists after reload", async ({ page }) => {
    const closed = await createIdleAgent(client, {
      cwd: tempRepo.path,
      title: `middle-close-${randomUUID().slice(0, 8)}`,
    });
    const survivor = await createIdleAgent(client, {
      cwd: tempRepo.path,
      title: `middle-survive-${randomUUID().slice(0, 8)}`,
    });

    await openWorkspaceWithAgents(page, [closed, survivor]);
    await waitForWorkspaceTabsVisible(page);

    await middleClickWorkspaceTab(page, `workspace-tab-agent_${closed.id}`);

    await expectWorkspaceTabHidden(page, closed.id);
    await expectWorkspaceTabVisible(page, survivor.id);

    await reloadWorkspace(page, tempRepo.path);
    await expectWorkspaceTabHidden(page, closed.id);
    await expectWorkspaceTabVisible(page, survivor.id);
  });
});
