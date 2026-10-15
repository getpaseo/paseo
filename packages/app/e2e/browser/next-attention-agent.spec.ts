import { test, expect } from "../support/fixtures";
import { openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { splitCurrentPanelRight } from "../support/helpers/chat-outline";

test("next attention visits unread conversations across workspaces and clears after reading", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const first = await seedMockAgentWorkspace({
    repoPrefix: "next-attention-first-",
    title: "First conversation with a deliberately long title for truncation",
  });
  const second = await seedMockAgentWorkspace({
    repoPrefix: "next-attention-second-",
    title: "Second workspace conversation",
  });
  try {
    const sibling = await first.client.createAgent({
      provider: "mock",
      cwd: first.cwd,
      workspaceId: first.workspaceId,
      title: "Second conversation in this workspace",
      modeId: "load-test",
      model: "e2e-fast-stream",
    });
    await first.client.waitForAgentUpsert(sibling.id, (agent) => agent.status === "idle", 30_000);
    await openWorkspaceWithAgents(page, [
      { id: first.agentId, title: "First", cwd: first.cwd, workspaceId: first.workspaceId },
      { id: sibling.id, title: "Sibling", cwd: first.cwd, workspaceId: first.workspaceId },
    ]);
    await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();

    await first.client.sendAgentMessage(first.agentId, "Finish this response.");
    await first.client.waitForFinish(first.agentId, 20_000);
    await first.client.sendAgentMessage(sibling.id, "Finish this response too.");
    await first.client.waitForFinish(sibling.id, 20_000);
    const firstTab = page
      .getByTestId(`workspace-tab-agent_${first.agentId}`)
      .filter({ visible: true });
    const siblingTab = page
      .getByTestId(`workspace-tab-agent_${sibling.id}`)
      .filter({ visible: true });
    await expect(
      firstTab.getByText("First conversation with a deliberately long title for truncation"),
    ).toHaveCSS("font-weight", "700");
    await expect(siblingTab.getByText("Second conversation in this workspace")).toHaveCSS(
      "font-weight",
      "700",
    );
    await page.screenshot({ path: "../../.context/next-attention-two-unread.png" });
    await openAgentRoute(page, second);

    const next = page.getByTestId("next-attention-agent").filter({ visible: true }).first();
    await expect(next).toBeVisible();
    await expect(next).toHaveAttribute("aria-label", "Open next conversation needing attention");
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${first.workspaceId}`));
    const unreadTab = page
      .getByTestId(`workspace-tab-agent_${sibling.id}`)
      .filter({ visible: true });
    await expect(unreadTab).toBeVisible();
    await expect(unreadTab.getByText("Second conversation in this workspace")).toHaveCSS(
      "font-weight",
      "700",
    );
    await page.screenshot({ path: "../../.context/next-attention-wide.png" });
    await splitCurrentPanelRight(page);
    await expect(next).toBeVisible();
    await page.screenshot({ path: "../../.context/next-attention-split.png" });

    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, first);
    await expect(next).toBeVisible();
    await page.screenshot({ path: "../../.context/next-attention-compact.png" });
    await page.getByTestId("workspace-tab-switcher-trigger").click();
    const switcherTitle = page.getByText("Switch tab", { exact: true }).filter({ visible: true });
    await expect(switcherTitle).toBeVisible();
    const unreadOption = page
      .getByText("Second conversation in this workspace", { exact: true })
      .filter({ visible: true })
      .first();
    await expect(unreadOption).toBeVisible();
    await expect(unreadOption).toHaveCSS("font-weight", "700");
    await page.waitForTimeout(500);
    await page.screenshot({ path: "../../.context/next-attention-switcher.png" });
    await unreadOption.click();
    await expect(next).toHaveCount(0);
    await expect(switcherTitle).toHaveCount(0);
    await expect(
      page
        .getByTestId("workspace-tab-switcher-trigger")
        .getByText("Second conversation in this workspace"),
    ).toHaveCSS("font-weight", "400");
    await page.screenshot({ path: "../../.context/next-attention-cleared.png" });

    const permission = await second.client.createAgent({
      provider: "mock",
      cwd: second.cwd,
      workspaceId: second.workspaceId,
      title: "Permission awaiting approval",
      modeId: "load-test",
      model: "ten-second-stream",
    });
    await second.client.waitForAgentUpsert(
      permission.id,
      (agent) => agent.status === "idle",
      30_000,
    );
    await second.client.sendAgentMessage(permission.id, "Emit synthetic plan approval.");
    expect((await second.client.waitForFinish(permission.id, 15_000)).status).toBe("permission");
    await expect(next).toBeVisible();
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${second.workspaceId}`));
    await expect(
      page.getByTestId("workspace-tab-switcher-trigger").getByText("Permission awaiting approval"),
    ).toHaveCSS("font-weight", "700");
    await expect(next).toHaveCount(0);
    await page.screenshot({ path: "../../.context/next-attention-permission.png" });
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
