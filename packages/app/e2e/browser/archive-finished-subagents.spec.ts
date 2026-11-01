import { test, expect } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  archiveFinishedSubagents,
  expectArchiveFinishedInProgress,
  expectArchiveFinishedRetry,
  expectManagedSubagentArchived,
  expectManagedSubagentUnarchived,
  expectSubagentRowGone,
  expectSubagentRowVisible,
  holdManagedSubagentArchiveRequest,
  openSubagentsTrack,
  rejectNextManagedSubagentArchiveRequest,
  seedParentWithSubagent,
  seedSubagent,
} from "../support/helpers/subagents";

test.describe("Archive finished subagents", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "archive-finished-subagents-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  for (const width of [1280, 390]) {
    test(`shows running children before finished history at width ${width}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const agents = await seedParentWithSubagent(workspace, {
        parentTitle: "Subagent ordering",
        childTitle: "Finished child 1",
      });
      for (let index = 2; index <= 12; index++) {
        await seedSubagent(workspace, {
          parentId: agents.parent.id,
          title: `Finished child ${index}`,
        });
      }
      const running = [];
      for (let index = 1; index <= 2; index++) {
        const child = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: `Running child ${index}`,
          modeId: "load-test",
          model: "five-minute-stream",
          initialPrompt: "stay running",
          labels: { "paseo.parent-agent-id": agents.parent.id },
        });
        running.push(child.id);
        await workspace.client.waitForAgentUpsert(
          child.id,
          (snapshot) => snapshot.status === "running",
        );
      }
      await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
      await expect(page.getByTestId("subagents-track-header")).toContainText("2 working");
      await page.getByTestId("subagents-track-header").click();
      const rows = page.locator(
        '[data-testid^="subagents-track-row-"]:not([data-testid^="subagents-track-row-facts-"])',
      );
      await expect(rows).toHaveCount(14);
      await expect(rows.nth(0)).toHaveAttribute("data-testid", `subagents-track-row-${running[0]}`);
      await expect(rows.nth(1)).toHaveAttribute("data-testid", `subagents-track-row-${running[1]}`);
      await expect(rows.nth(0)).toBeInViewport();
      await expect(rows.nth(1)).toBeInViewport();
      await rows.nth(0).click({ trial: true });
      const screenshot = testInfo.outputPath("subagent-order.png");
      await page.screenshot({ path: screenshot });
      await testInfo.attach("subagent-order", { path: screenshot, contentType: "image/png" });
    });
  }

  test("archives a finished managed child from the track", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Archive parent",
      childTitle: "Finished child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const archiveGate = await holdManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await archiveGate.waitForRequest();

    await expectSubagentRowGone(page, agents.child.id);
    await expectArchiveFinishedInProgress(page, 0, 1);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    archiveGate.release();
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });

  test("restores a failed child and retries the archive", async ({ page }) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Retry parent",
      childTitle: "Retry child",
    });
    await workspace.client.waitForAgentUpsert(
      agents.child.id,
      (snapshot) => snapshot.status === "idle",
    );

    const rejection = await rejectNextManagedSubagentArchiveRequest(page, agents.child.id);
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    await openSubagentsTrack(page);
    await expectSubagentRowVisible(page, agents.child.id);

    await archiveFinishedSubagents(page);
    await rejection.waitForRejection();

    await expectSubagentRowVisible(page, agents.child.id);
    await expectArchiveFinishedRetry(page, 1, 1);
    await archiveFinishedSubagents(page);

    await expectSubagentRowGone(page, agents.child.id);
    await expectManagedSubagentArchived(workspace, agents.child.id);
  });
});
