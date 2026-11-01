import { PARENT_AGENT_ID_LABEL, parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  archiveFinishedSubagents,
  delegateFleetThroughMcp,
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

test.use({ e2eInjectPaseoTools: true });

test.describe("Archive finished subagents", () => {
  let workspace: SeededWorkspace;

  test.beforeAll(async () => {
    workspace = await seedWorkspace({ repoPrefix: "archive-finished-subagents-" });
  });

  test.afterAll(async () => {
    await workspace?.cleanup();
  });

  test("keeps an idle child's active subtree working and out of Archive finished", async ({
    page,
  }, testInfo) => {
    const agents = await seedParentWithSubagent(workspace, {
      parentTitle: "Active subtree parent",
      childTitle: "Idle child with delegated work",
    });
    const sibling = await seedSubagent(workspace, {
      parentId: agents.parent.id,
      title: "Finished sibling",
    });
    const grandchild = await workspace.client.createAgent({
      provider: "mock",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Running grandchild",
      modeId: "load-test",
      model: "five-minute-stream",
      initialPrompt: "stay running",
      labels: { [PARENT_AGENT_ID_LABEL]: agents.child.id },
    });
    await workspace.client.waitForAgentUpsert(grandchild.id, (agent) => agent.status === "running");
    await openAgentRoute(page, { workspaceId: agents.workspaceId, agentId: agents.parent.id });
    const pill = page.getByTestId("subagents-track-header");
    await expect(pill).toHaveAttribute("aria-label", "1 working");
    const parentTab = page.getByTestId(`workspace-tab-agent_${agents.parent.id}`);
    await expect(parentTab.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
    await openSubagentsTrack(page);
    const childRow = page.getByTestId(`subagents-track-row-${agents.child.id}`);
    await expect(childRow.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
    const screenshotPath = testInfo.outputPath("active-descendant-track-and-tab.png");
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach("active-descendant-track-and-tab", {
      path: screenshotPath,
      contentType: "image/png",
    });
    await archiveFinishedSubagents(page);
    await expectManagedSubagentArchived(workspace, sibling.id);
    await expectManagedSubagentUnarchived(workspace, agents.child.id);
    await expectManagedSubagentUnarchived(workspace, grandchild.id);
    await expectSubagentRowVisible(page, agents.child.id);
    await expect(page.getByTestId("subagents-track-archive-finished")).toHaveCount(0);
    await workspace.client.cancelAgent(grandchild.id);
    await workspace.client.waitForAgentUpsert(grandchild.id, (agent) => agent.status === "idle");
    await expect(pill).toHaveAttribute("aria-label", "1 subagent");
    await expect(parentTab.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
    await expect(childRow.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
    await archiveFinishedSubagents(page);
    await expectManagedSubagentArchived(workspace, agents.child.id);
    await expectManagedSubagentArchived(workspace, grandchild.id);
  });

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

test("keeps a remote child's active subtree working and archives on its own host", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const fleet = await delegateFleetThroughMcp();
  try {
    // Settle both MCP-created child turns and their notifications before seeding
    // the remote descendant, so the local child is the finished sibling.
    await Promise.all([fleet.expectCompletion(fleet.local), fleet.expectCompletion(fleet.remote)]);
    await Promise.all([
      fleet.a.waitForAgentUpsert(fleet.local.agentId, (agent) => agent.status === "idle"),
      fleet.b.waitForAgentUpsert(fleet.remote.agentId, (agent) => agent.status === "idle"),
      fleet.a.waitForAgentUpsert(fleet.parent.id, (agent) => agent.status === "idle"),
    ]);

    const grandchild = await fleet.b.createAgent({
      provider: "mock",
      cwd: fleet.workspace.repoPath,
      workspaceId: fleet.remote.workspaceId,
      title: "Running grandchild on B",
      modeId: "load-test",
      model: "five-minute-stream",
      initialPrompt: "stay running",
      labels: parentAddressLabels(fleet.remote),
    });
    await fleet.b.waitForAgentUpsert(grandchild.id, (agent) => agent.status === "running");

    // Open only A's parent. B and its grandchild have never had an open pane.
    await openAgentRoute(page, {
      workspaceId: fleet.workspace.workspaceId,
      agentId: fleet.parent.id,
    });
    await openSubagentsTrack(page);
    const remoteRow = page.getByTestId(`subagents-track-row-${fleet.remote.agentId}`);
    const localRow = page.getByTestId(`subagents-track-row-${fleet.local.agentId}`);
    const pill = page.getByTestId("subagents-track-header");
    const parentTab = page.getByTestId(`workspace-tab-agent_${fleet.parent.id}`);
    await expect(remoteRow).toContainText("MCP child on B");
    await expect(remoteRow).toContainText("Fleet B");
    await expect(localRow).toContainText("MCP child on A");
    await expect(fleet.b.fetchAgent(fleet.remote.agentId)).resolves.toMatchObject({
      agent: { status: "idle", archivedAt: null },
    });

    // Capture the same opened track on both baseline failure and fixed success.
    // The existing failure-only Playwright screenshot would otherwise miss the
    // track if an inherited-activity assertion ran before opening it.
    try {
      await expect(pill).toHaveAttribute("aria-label", "1 working");
      await expect(remoteRow.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
      await expect(localRow.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
      await expect(parentTab.getByRole("progressbar", { name: "Agent running" })).toBeVisible();
    } finally {
      const screenshotPath = testInfo.outputPath("cross-host-active-descendant-track-and-tab.png");
      await expect
        .poll(() =>
          remoteRow.evaluate((element) => {
            let opacity = 1;
            for (let node: Element | null = element; node; node = node.parentElement) {
              opacity *= Number(getComputedStyle(node).opacity);
            }
            return opacity;
          }),
        )
        .toBeGreaterThan(0.99);
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach("cross-host-active-descendant-track-and-tab", {
        path: screenshotPath,
        contentType: "image/png",
      });
    }

    await archiveFinishedSubagents(page);
    await expectManagedSubagentArchived({ client: fleet.a }, fleet.local.agentId);
    await expectSubagentRowGone(page, fleet.local.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.b }, fleet.remote.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.b }, grandchild.id);
    await expect(remoteRow).toBeVisible();
    await expect(page.getByTestId("subagents-track-archive-finished")).toHaveCount(0);

    // The fleet helper creates unrelated equal-ID agents on the opposite hosts.
    // Neither archiving local A nor protecting remote B may touch those agents.
    await expectManagedSubagentUnarchived({ client: fleet.b }, fleet.local.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.a }, fleet.remote.agentId);

    await fleet.b.cancelAgent(grandchild.id);
    await fleet.b.waitForAgentUpsert(grandchild.id, (agent) => agent.status === "idle");
    await expect(pill).toHaveAttribute("aria-label", "1 subagent");
    await expect(remoteRow.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
    await expect(parentTab.getByRole("progressbar", { name: "Agent running" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Archive finished subagents" })).toBeEnabled();

    const finishedScreenshotPath = testInfo.outputPath("cross-host-descendant-finished.png");
    await page.screenshot({ path: finishedScreenshotPath });
    await testInfo.attach("cross-host-descendant-finished", {
      path: finishedScreenshotPath,
      contentType: "image/png",
    });

    await archiveFinishedSubagents(page);
    await expectManagedSubagentArchived({ client: fleet.b }, fleet.remote.agentId);
    await expectManagedSubagentArchived({ client: fleet.b }, grandchild.id);
    await expectSubagentRowGone(page, fleet.remote.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.a }, fleet.remote.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.b }, fleet.local.agentId);
    await expectManagedSubagentUnarchived({ client: fleet.a }, fleet.parent.id);
  } finally {
    await fleet.close();
  }
});
